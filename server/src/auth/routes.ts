import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.ts';
import { challengeFor, createOidc, randomNonce, randomState, randomVerifier } from './oidc.ts';
import { createLoginAttempt, createSession, deleteSession, takeLoginAttempt, SESSION_TTL_MS, LOGIN_TTL_MS } from './sessions.ts';
import { upsertUserFromClaims, type User } from '../users.ts';
import { cookieNames } from './cookies.ts';

const requireUser = (req: FastifyRequest): { user: User; session: { idHash: string; csrfToken: string } } => {
  if (!req.user || !req.session) throw new AppError('UNAUTHENTICATED');
  return { user: req.user, session: req.session };
};

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;
  const oidc = await createOidc(config);
  const names = cookieNames(config);
  const safeReturnTo = (v: unknown): string => {
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    if (typeof v !== 'string' || !v.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(v)) return '/';
    const u = new URL(v, config.publicUrl);
    return u.origin === config.publicUrl.origin ? u.pathname + u.search + u.hash : '/';
  };
  const secure = config.publicUrl.protocol === 'https:';
  const cookieBase = { httpOnly: true, sameSite: 'lax' as const, secure, path: '/' };

  // __Host- requires Path=/; otherwise narrow the login cookie to the callback.
  const loginCookie = names.prefixed ? cookieBase : { ...cookieBase, path: '/auth/callback' };

  app.get('/auth/login', { config: { public: true } }, async (req, reply) => {
    const q = z.object({ returnTo: z.string().optional(), login_hint: z.string().max(200).optional() }).parse(req.query);
    const state = randomState(); const nonce = randomNonce(); const verifier = randomVerifier();
    const id = createLoginAttempt(db, { state, nonce, verifier, returnTo: safeReturnTo(q.returnTo) });
    reply.setCookie(names.login, id, { ...loginCookie, maxAge: LOGIN_TTL_MS / 1000 });
    const url = oidc.authorizationUrl({ state, nonce, challenge: await challengeFor(verifier), ...(q.login_hint ? { loginHint: q.login_hint } : {}) });
    return reply.redirect(url.href);
  });

  app.get('/auth/callback', { config: { public: true } }, async (req, reply) => {
    const id = req.cookies[names.login];
    const attempt = id ? takeLoginAttempt(db, id) : undefined;
    reply.clearCookie(names.login, loginCookie);
    if (!attempt) throw new AppError('LOGIN_FAILED');
    const callbackUrl = new URL(req.url, config.publicUrl);
    let claims;
    try { claims = await oidc.exchange(callbackUrl, attempt); }
    catch (err) { throw new AppError('LOGIN_FAILED', undefined, { cause: err }); }
    const roleValue = claims[config.oidc.roleClaim];
    const isAdmin = Array.isArray(roleValue) ? roleValue.includes(config.oidc.adminValue) : roleValue === config.oidc.adminValue;
    const user = upsertUserFromClaims(db, { iss: claims.iss, sub: claims.sub, isAdmin,
      ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
      ...(typeof claims.email === 'string' ? { email: claims.email } : {}) });
    if (req.session) deleteSession(db, req.session.idHash); // session fixation hygiene
    const s = createSession(db, user.id);
    reply.setCookie(names.sid, s.id, { ...cookieBase, maxAge: SESSION_TTL_MS / 1000 });
    return reply.redirect(attempt.returnTo);
  });

  app.post('/auth/logout', async (req, reply) => {
    deleteSession(db, requireUser(req).session.idHash);
    reply.clearCookie(names.sid, cookieBase);
    return reply.status(204).send();
  });

  app.get('/api/v1/me', async (req) => {
    const { user, session } = requireUser(req);
    return { ...user, csrfToken: session.csrfToken };
  });
}
