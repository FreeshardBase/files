import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { errorHandler } from './errors.ts';
import { registerGuard } from './auth/guard.ts';
import { registerAuthRoutes } from './auth/routes.ts';
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

  extend?.(app);
  return app;
}
