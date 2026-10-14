import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors.ts';
import { findSession } from './sessions.ts';
import { getUser, type User } from '../users.ts';

declare module 'fastify' {
  interface FastifyRequest { user?: User; session?: { idHash: string; csrfToken: string } }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function registerGuard(app: FastifyInstance): void {
  const { db, config } = app.deps;
  app.decorateRequest('user', undefined);
  app.decorateRequest('session', undefined);
  app.addHook('onRequest', async (req) => {
    const sid = req.cookies.fs_sid;
    if (sid) {
      const s = findSession(db, sid);
      const u = s && getUser(db, s.userId);
      if (s && u) { req.user = u; req.session = { idHash: s.idHash, csrfToken: s.csrfToken }; }
    }
    const isPublic = req.routeOptions.config?.public === true;
    const isApiOrAuth = req.url.startsWith('/api/') || req.url.startsWith('/auth/');
    if (isPublic || !isApiOrAuth) return;
    if (!req.user) throw new AppError('UNAUTHENTICATED');
    if (!SAFE.has(req.method)) {
      const origin = req.headers.origin;
      if (origin !== config.publicUrl.origin) throw new AppError('CSRF');
      if (req.headers['x-csrf-token'] !== req.session!.csrfToken) throw new AppError('CSRF');
    }
  });
}
