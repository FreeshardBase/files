import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.ts';
import { challengeFor, createOidc, randomNonce, randomState, randomVerifier } from './oidc.ts';
import { createLoginAttempt, createSession, deleteSession, takeLoginAttempt, SESSION_TTL_MS, LOGIN_TTL_MS } from './sessions.ts';
import { upsertUserFromClaims } from '../users.ts';

const safeReturnTo = (v: unknown) =>
  typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') ? v : '/';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;
  const oidc = await createOidc(config);
  const secure = config.publicUrl.protocol === 'https:';
  const cookieBase = { httpOnly: true, sameSite: 'lax' as const, secure, path: '/' };

  app.get('/auth/login', { config: { public: true } }, async (req, reply) => {
    const q = z.object({ returnTo: z.string().optional(), login_hint: z.string().max(200).optional() }).parse(req.query);
    const state = randomState(); const nonce = randomNonce(); const verifier = randomVerifier();
    const id = createLoginAttempt(db, { state, nonce, verifier, returnTo: safeReturnTo(q.returnTo) });
    reply.setCookie('fs_login', id, { ...cookieBase, maxAge: LOGIN_TTL_MS / 1000 });
    const url = oidc.authorizationUrl({ state, nonce, challenge: await challengeFor(verifier), ...(q.login_hint ? { loginHint: q.login_hint } : {}) });
    return reply.redirect(url.href);
  });

  app.get('/auth/callback', { config: { public: true } }, async (req, reply) => {
    const id = req.cookies.fs_login;
    const attempt = id ? takeLoginAttempt(db, id) : undefined;
    reply.clearCookie('fs_login', cookieBase);
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
    const s = createSession(db, user.id);
    reply.setCookie('fs_sid', s.id, { ...cookieBase, maxAge: SESSION_TTL_MS / 1000 });
    return reply.redirect(attempt.returnTo);
  });

  app.post('/auth/logout', async (req, reply) => {
    deleteSession(db, req.session!.idHash);
    reply.clearCookie('fs_sid', cookieBase);
    return reply.status(204).send();
  });

  app.get('/api/v1/me', async (req) => ({ ...req.user!, csrfToken: req.session!.csrfToken }));
}
