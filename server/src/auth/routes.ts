import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { challengeFor, createOidc, randomNonce, randomState, randomVerifier } from './oidc.ts';
import { createLoginAttempt, createSession, deleteSession, takeLoginAttempt, SESSION_TTL_MS, LOGIN_TTL_MS } from './sessions.ts';
import { upsertUserFromClaims } from '../users.ts';
import { layoutOf, settingsOf, sortOf } from '../settings.ts';
import { cookieNames } from './cookies.ts';
import { requireUser } from './guard.ts';

export const LOGIN_FAILED_URL = '/?loginError=1';
const RETURN_TO_MAX = 2048;

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;
  const oidc = await createOidc(config);
  const names = cookieNames(config);
  const safeReturnTo = (v: unknown): string => {
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || /[\x00-\x1f\x7f\\]/.test(v)) return '/';
    if (v.split('?')[0]!.split('#')[0]!.split('/').some((seg) => seg === '.' || seg === '..')) return '/';
    let u: URL;
    try { u = new URL(v, config.publicUrl); }
    catch { return '/'; } // handled: unparsable returnTo falls back to /
    if (u.origin !== config.publicUrl.origin) return '/';
    const out = u.pathname + u.search + u.hash;
    // Bounded after normalising too: percent-encoding grows a non-ASCII path up to ninefold, and it is stored (#255).
    return out.startsWith('/') && !out.startsWith('//') && out.length <= RETURN_TO_MAX ? out : '/';
  };
  const secure = config.publicUrl.protocol === 'https:';
  const cookieBase = { httpOnly: true, sameSite: 'lax' as const, secure, path: '/' };

  // __Host- requires Path=/; otherwise narrow the login cookie to the callback.
  const loginCookie = names.prefixed ? cookieBase : { ...cookieBase, path: '/auth/callback' };

  app.get('/auth/login', { config: { public: true } }, async (req, reply) => {
    const q = z.object({ returnTo: z.string().optional().transform((v) => (v !== undefined && v.length > RETURN_TO_MAX ? undefined : v)), login_hint: z.string().max(200).optional() }).parse(req.query);
    const state = randomState(); const nonce = randomNonce(); const verifier = randomVerifier();
    const id = createLoginAttempt(db, { state, nonce, verifier, returnTo: safeReturnTo(q.returnTo) });
    // The most live attempts exist (#255): back to the SPA, which shows LOGIN_FAILED instead of looping into login.
    if (id === undefined) {
      req.log.warn('login refused: too many live login attempts');
      return reply.redirect(LOGIN_FAILED_URL);
    }
    reply.setCookie(names.login, id, { ...loginCookie, maxAge: LOGIN_TTL_MS / 1000 });
    const url = oidc.authorizationUrl({ state, nonce, challenge: await challengeFor(verifier), ...(q.login_hint ? { loginHint: q.login_hint } : {}) });
    return reply.redirect(url.href);
  });

  app.get('/auth/callback', { config: { public: true } }, async (req, reply) => {
    const id = req.cookies[names.login];
    const attempt = id ? takeLoginAttempt(db, id) : undefined;
    reply.clearCookie(names.login, loginCookie);
    // A failed login goes back to the SPA, which shows LOGIN_FAILED and a link to sign in again.
    // Only a flag travels in the URL; the reason is logged here, never shown to the browser.
    const failed = (reason: string, err?: unknown) => {
      req.log.warn({ err, reason }, 'login failed');
      return reply.redirect(LOGIN_FAILED_URL);
    };
    if (!attempt) return failed('missing or expired login attempt');
    const callbackUrl = new URL(req.url, config.publicUrl);
    let claims;
    try { claims = await oidc.exchange(callbackUrl, attempt); }
    catch (err) { return failed('code exchange rejected', err); } // handled: state mismatch, IdP error=, bad code
    // Without a configured admin claim nobody is admin (least privilege).
    const admin = config.oidc.admin;
    const roleValue = admin && claims[admin.claim];
    const isAdmin = admin !== undefined && (Array.isArray(roleValue) ? roleValue.includes(admin.value) : roleValue === admin.value);
    const user = upsertUserFromClaims(db, { iss: claims.iss, sub: claims.sub, isAdmin,
      ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
      ...(typeof claims.preferred_username === 'string' ? { preferredUsername: claims.preferred_username } : {}),
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
    return { ...user, csrfToken: session.csrfToken, settings: settingsOf(db, user.id), sort: sortOf(db, user.id),
      layout: layoutOf(db, user.id) };
  });
}
