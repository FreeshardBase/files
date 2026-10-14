import Fastify, { type FastifyInstance } from 'fastify';
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

declare module 'fastify' {
  interface FastifyContextConfig { public?: boolean }
  interface FastifyInstance { deps: { config: Config; db: Db } }
}

export type AppDeps = { config: Config; db: Db; extend?: (app: FastifyInstance) => void;
  logStream?: NodeJS.WritableStream };

export async function buildApp({ config, db, extend, logStream }: AppDeps): Promise<FastifyInstance> {
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
  app.setErrorHandler(errorHandler);
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], imgSrc: ["'self'", 'blob:', 'data:'], mediaSrc: ["'self'", 'blob:'],
        frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  app.decorate('deps', { config, db });

  registerGuard(app);
  await registerAuthRoutes(app);
  await registerSourceRoutes(app);
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
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.get('/*', { config: { public: true } }, (req, reply) => {
      // Decide on the decoded path: the router matches the raw URL, so /%61pi/... lands here.
      let path: string;
      try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
      catch { return reply.callNotFound(); } // malformed escape: not a page, answer through the not-found handler
      if (path.startsWith('/api/') || path.startsWith('/auth/')) return reply.callNotFound();
      return reply.sendFile('index.html');
    });
  }

  extend?.(app);
  return app;
}
