import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../errors.ts';
import { cookieNames } from './cookies.ts';
import { findSession } from './sessions.ts';
import { getUser, type User } from '../users.ts';

declare module 'fastify' {
  interface FastifyRequest { user?: User; session?: { idHash: string; csrfToken: string } }
}

const safeEqual = (a: unknown, b: string): boolean => {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const requireUser = (req: FastifyRequest): { user: User; session: { idHash: string; csrfToken: string } } => {
  if (!req.user || !req.session) throw new AppError('UNAUTHENTICATED');
  return { user: req.user, session: req.session };
};

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function registerGuard(app: FastifyInstance): void {
  const { db, config } = app.deps;
  const names = cookieNames(config);
  app.decorateRequest('user', undefined);
  app.decorateRequest('session', undefined);
  app.addHook('onRequest', async (req) => {
    const sid = req.cookies[names.sid];
    if (sid) {
      const s = findSession(db, sid);
      const u = s && getUser(db, s.userId);
      if (s && u) { req.user = u; req.session = { idHash: s.idHash, csrfToken: s.csrfToken }; }
    }
    // Decide on the matched route, never the raw URL (the router decodes %61pi etc.). Every matched
    // route needs a session unless it is on the explicit allowlist (`config: { public: true }`).
    // Unmatched requests have no pattern and fall through to the not-found handler (401 without a user).
    const protectedRoute = req.routeOptions.url !== undefined && req.routeOptions.config?.public !== true;
    if (!protectedRoute) return;
    if (!req.user) throw new AppError('UNAUTHENTICATED');
    if (!SAFE.has(req.method)) {
      if (!req.session) throw new AppError('UNAUTHENTICATED');
      const origin = req.headers.origin;
      if (origin !== config.publicUrl.origin) throw new AppError('CSRF');
      if (!safeEqual(req.headers['x-csrf-token'], req.session.csrfToken)) throw new AppError('CSRF');
    }
  });
}
