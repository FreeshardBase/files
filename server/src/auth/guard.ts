import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../errors.ts';
import { cookieNames } from './cookies.ts';
import { findSession } from './sessions.ts';
import { getUser, type User } from '../users.ts';
import { authenticateAppPassword } from './appPasswords.ts';

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

/** The caller, who must be the shard admin (#156). The role comes only from the OIDC claim, mapped at each sign-in. */
export const requireAdmin = (req: FastifyRequest): { user: User; session: { idHash: string; csrfToken: string } } => {
  const s = requireUser(req);
  if (s.user.role !== 'admin') throw new AppError('FORBIDDEN');
  return s;
};

/** The member a WebDAV request authenticated as with an app password (#157); WebDAV routes have no session. */
export const requireDavUser = (req: FastifyRequest): User => {
  if (!req.user || req.routeOptions.config?.appPassword !== true) throw new AppError('UNAUTHENTICATED');
  return req.user;
};

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
export const DAV_REALM = 'Basic realm="FreeShard Files", charset="UTF-8"';

// `Authorization: Basic <base64(user:password)>`; the user name is not checked, the app password names its member.
function basicPassword(header: string | undefined): string | undefined {
  const m = /^Basic +([A-Za-z0-9+/]+=*) *$/i.exec(header ?? '');
  if (!m) return undefined;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? undefined : decoded.slice(colon + 1);
}

export function registerGuard(app: FastifyInstance): void {
  const { db, config } = app.deps;
  const names = cookieNames(config);
  app.decorateRequest('user', undefined);
  app.decorateRequest('session', undefined);
  app.addHook('onRequest', async (req, reply) => {
    // The WebDAV route family (`config: { appPassword: true }`) takes an app password over HTTP Basic and nothing else:
    // the session cookie is ignored there, so a page in the browser can never reach WebDAV with the member's session.
    // A request that a web page sent (it carries an Origin) must come from the app's own origin.
    if (req.routeOptions.config?.appPassword === true) {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== config.publicUrl.origin) throw new AppError('FORBIDDEN');
      const password = basicPassword(req.headers.authorization);
      const user = password === undefined ? undefined : await authenticateAppPassword(db, password);
      if (!user) {
        reply.header('www-authenticate', DAV_REALM);
        throw new AppError('UNAUTHENTICATED');
      }
      req.user = user;
      return;
    }
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
