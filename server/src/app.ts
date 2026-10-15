import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from '@fastify/helmet';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { errorHandler } from './errors.ts';
import { registerGuard } from './auth/guard.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { registerSourceRoutes } from './routes/sources.ts';
import { purgeExpired } from './auth/sessions.ts';
import { sweepUploadTemps } from './storage/uploadSweep.ts';
import { PATH_TABLES, TRASH_TABLES, type PathTable, type TrashTable } from './storage/pathRefs.ts';
import { registerTrashRoutes } from './routes/trash.ts';
import { scheduleTrashExpiry } from './storage/trash.ts';
import { registerUploadRoutes } from './routes/uploads.ts';
import { scheduleUploadExpiry } from './storage/uploads.ts';
import { registerRecentRoutes } from './routes/recent.ts';
import { registerSearchRoutes } from './routes/search.ts';
import { registerShareRoutes } from './routes/shares.ts';
import type { ConnectedBackend } from './storage/backend.ts';
import type { User } from './users.ts';
import { ThumbnailCache } from './storage/thumbnails.ts';
import { thumbsDir } from './paths.ts';

declare module 'fastify' {
  interface FastifyContextConfig { public?: boolean }
  interface FastifyInstance { deps: { config: Config; db: Db; pathTables: readonly PathTable[]; trashTables: readonly TrashTable[];
    thumbs: ThumbnailCache; connections: Connections } }
}

/** A member's own cloud connections. None exist until #148 adds the connection rows. */
export type Connections = (user: User) => Promise<ConnectedBackend[]>;
const noConnections: Connections = async () => [];

export type AppDeps = { config: Config; db: Db; extend?: (app: FastifyInstance) => void;
  /** Path-dependent tables that moves and deletes cascade to; `PATH_TABLES` unless a test brings its own. */
  pathTables?: readonly PathTable[];
  /** Tables whose rows hang off a trash row and are purged with it; `TRASH_TABLES` unless a test brings its own. */
  trashTables?: readonly TrashTable[];
  /** The member's cloud connections (search merges them); none until #148, unless a test brings its own backends. */
  connections?: Connections;
  logStream?: NodeJS.WritableStream;
  /** Observes every registered route (the test harness builds the route inventory from it). */
  onRoute?: (route: RouteOptions) => void };

export async function buildApp({ config, db, extend, logStream, onRoute, pathTables = PATH_TABLES, trashTables = TRASH_TABLES,
  connections = noConnections }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(logStream ? { stream: logStream } : {}),
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      serializers: { req: (req) => ({ method: req.method, path: req.url.split('?')[0], id: req.id }) },
    },
    trustProxy: (_address, hop) => hop < 1, // trust exactly one proxy hop (number form is not in the typings)
    bodyLimit: 1024 * 1024,
  });
  if (onRoute) app.addHook('onRoute', onRoute);
  app.setErrorHandler(errorHandler);
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"], connectSrc: ["'self'"], imgSrc: ["'self'", 'blob:', 'data:'], mediaSrc: ["'self'", 'blob:'],
        frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  const thumbs = new ThumbnailCache({ db, dir: thumbsDir(config.dataDir), capBytes: config.thumbCacheBytes, timeoutMs: config.thumbTimeoutMs });
  app.decorate('deps', { config, db, pathTables, trashTables, thumbs, connections });
  // listen() and inject() both wait for onReady, so no upload can be in flight while orphaned temp files are removed.
  app.addHook('onReady', async () => { await sweepUploadTemps(config.dataDir, app.log); await thumbs.sweep(app.log); });
  // Expiry starts once the sweep is done and is awaited on close, so it never runs against a closed database.
  let expiry: { stop(): Promise<void> } | undefined;
  let uploadExpiry: { stop(): Promise<void> } | undefined;
  app.addHook('onReady', async () => {
    expiry = scheduleTrashExpiry(app.deps, app.log);
    uploadExpiry = scheduleUploadExpiry(app.deps, app.log);
  });
  app.addHook('onClose', async () => { await expiry?.stop(); await uploadExpiry?.stop(); });

  registerGuard(app);
  await registerAuthRoutes(app);
  await registerSourceRoutes(app);
  await registerTrashRoutes(app);
  await registerUploadRoutes(app);
  await registerRecentRoutes(app);
  await registerSearchRoutes(app);
  await registerShareRoutes(app);
  app.setNotFoundHandler((req, reply) => {
    if (!req.user) {
      return reply.status(401).send({ code: 'UNAUTHENTICATED' });
    }
    return reply.status(404).send({ code: 'NOT_FOUND' });
  });
  const purge = setInterval(() => purgeExpired(db), 3600_000);
  purge.unref();
  app.addHook('onClose', async () => clearInterval(purge));

  app.get('/healthz', { config: { public: true } }, async () => ({ status: 'ok' }));

  // SPA: static assets plus an index.html fallback for client-side routes. FILES_WEB_DIST is a layout
  // override (the container sets it), not a security setting. Registered last so every API route wins.
  const webDist = process.env.FILES_WEB_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  if (existsSync(webDist)) {
    // Encapsulated so its onRoute hook marks exactly the static asset routes public (the bundle is not secret).
    await app.register(async (spa) => {
      spa.addHook('onRoute', (route) => { route.config = { ...route.config, public: true }; });
      await spa.register(fastifyStatic, { root: webDist, wildcard: false });
      spa.get('/*', { config: { public: true } }, (req, reply) => {
        // Decide on the decoded path: the router matches the raw URL, so /%61pi/... lands here.
        let path: string;
        try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
        catch { return reply.callNotFound(); } // malformed escape: not a page, answer through the not-found handler
        if (path.startsWith('/api/') || path.startsWith('/auth/')) return reply.callNotFound();
        return reply.sendFile('index.html');
      });
    });
  }

  extend?.(app);
  return app;
}
