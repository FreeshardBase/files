import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieNames } from '../src/auth/cookies.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp({}, (app) => {
    app.post('/api/v1/__mutate', async () => ({ mutated: true }));
  });
});
afterAll(() => t.close());

const names = () => cookieNames(t.config);

// A failed login lands back in the app with a flag only: no code, reason or IdP text in the URL.
function expectLoginFailed(r: { statusCode: number; headers: Record<string, unknown> }) {
  expect(r.statusCode).toBe(302);
  expect(r.headers.location).toBe('/?loginError=1');
}

// Starts a login and returns the login cookie plus the callback URL the IdP would redirect to.
async function startAttempt(user = 'testuser') {
  const start = await t.app.inject(`/auth/login?login_hint=${user}`);
  const cookie = String(start.headers['set-cookie']).split(';')[0]!;
  const idp = await fetch(String(start.headers.location), { redirect: 'manual' });
  const back = new URL(idp.headers.get('location')!);
  return { cookie, url: back.pathname + back.search, params: back.searchParams };
}

describe('deny by default', () => {
  it('rejects /api/v1/me without a session', async () => {
    const r = await t.app.inject('/api/v1/me');
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ code: 'UNAUTHENTICATED' });
  });
  it('rejects an unknown route under /api with 401, not 404', async () => {
    expect((await t.app.inject('/api/v1/does-not-exist')).statusCode).toBe(401);
  });
  it('is not bypassed by percent-encoded paths', async () => {
    expect((await t.app.inject('/%61pi/v1/me')).statusCode).toBe(401);
    const r = await t.app.inject({ method: 'POST', url: '/%61pi/v1/__mutate' });
    expect(r.statusCode).toBe(401);
  });
  it('enforces CSRF on percent-encoded mutating paths', async () => {
    const s = await login(t);
    const r = await t.app.inject({ method: 'POST', url: '/%61pi/v1/__mutate',
      headers: { cookie: s.cookie, origin: 'https://files.example.com' } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ code: 'CSRF' });
    const ok = await t.app.inject({ method: 'POST', url: '/%61pi/v1/__mutate',
      headers: { cookie: s.cookie, origin: 'https://files.example.com', 'x-csrf-token': s.csrf } });
    expect(ok.statusCode).toBe(200);
  });
  it('returns 404 for unknown routes when authenticated', async () => {
    const s = await login(t);
    expect((await t.app.inject({ url: '/api/v1/nope', headers: { cookie: s.cookie } })).statusCode).toBe(404);
  });
});

describe('OIDC login', () => {
  it('logs in through the real code + PKCE flow and maps the admin role', async () => {
    const s = await login(t, 'testuser');
    const r = await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ displayName: 'Test User', email: 'testuser@example.com', role: 'admin' });
  });
  it('maps a non-admin to member and keeps a stable id across logins', async () => {
    const a = await login(t, 'member');
    const b = await login(t, 'member');
    const me = async (c: string) => (await t.app.inject({ url: '/api/v1/me', headers: { cookie: c } })).json();
    expect((await me(a.cookie)).role).toBe('member');
    expect((await me(a.cookie)).id).toBe((await me(b.cookie)).id);
  });
  it('rejects a callback whose state was tampered with after a real IdP round trip', async () => {
    const a = await startAttempt();
    const u = new URL(a.url, 'https://files.example.com');
    u.searchParams.set('state', 'forged');
    const r = await t.app.inject({ url: u.pathname + u.search, headers: { cookie: a.cookie } });
    expectLoginFailed(r);
  });
  it('does not let login cookie A complete callback B', async () => {
    const a = await startAttempt();
    const b = await startAttempt();
    const r = await t.app.inject({ url: b.url, headers: { cookie: a.cookie } });
    expectLoginFailed(r);
  });
  it('rejects a replayed callback', async () => {
    const a = await startAttempt();
    expect((await t.app.inject({ url: a.url, headers: { cookie: a.cookie } })).statusCode).toBe(302);
    expect((t.db.prepare('SELECT count(*) AS n FROM login_attempts WHERE state = ?').get(a.params.get('state')) as { n: number }).n).toBe(0);
    expectLoginFailed(await t.app.inject({ url: a.url, headers: { cookie: a.cookie } }));
  });
  it('rejects a callback for an expired login attempt', async () => {
    const a = await startAttempt();
    t.db.prepare("UPDATE login_attempts SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const r = await t.app.inject({ url: a.url, headers: { cookie: a.cookie } });
    expectLoginFailed(r);
  });
  it('invalidates a pre-existing session on re-login (fixation hygiene)', async () => {
    const old = await login(t);
    const a = await startAttempt();
    const r = await t.app.inject({ url: a.url, headers: { cookie: `${a.cookie}; ${old.cookie}` } });
    expect(r.statusCode).toBe(302);
    expect((await t.app.inject({ url: '/api/v1/me', headers: { cookie: old.cookie } })).statusCode).toBe(401);
  });
  it('uses __Host- prefixed, Secure, Path=/ cookies on https', async () => {
    const start = await t.app.inject('/auth/login');
    const c = String(start.headers['set-cookie']);
    expect(names().sid).toBe('__Host-fs_sid');
    expect(c).toMatch(/^__Host-fs_login=/);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/Path=\/(;|$)/);
    expect(c).not.toMatch(/Domain=/i);
  });
  it('rejects a callback without a login cookie even if state is supplied', async () => {
    expectLoginFailed(await t.app.inject('/auth/callback?code=x&state=anything'));
  });
  it('sends an IdP error= callback back to the app without the details', async () => {
    const a = await startAttempt();
    const st = a.params.get('state')!;
    const r = await t.app.inject({ url: `/auth/callback?error=access_denied&error_description=${encodeURIComponent('<b>nope</b>')}&state=${st}`,
      headers: { cookie: a.cookie } });
    expectLoginFailed(r);
    expect(r.body).not.toContain('nope');
  });
  it('does not create a session on a failed callback', async () => {
    const a = await startAttempt();
    const u = new URL(a.url, 'https://files.example.com');
    u.searchParams.set('state', 'forged');
    const r = await t.app.inject({ url: u.pathname + u.search, headers: { cookie: a.cookie } });
    expectLoginFailed(r);
    const set = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
    expect(set.some((c) => c.startsWith(`${names().sid}=`))).toBe(false);
  });
  it.each([
    ['https://evil.example/'], ['//evil.example'], ['/\\evil.example'], ['/\t/evil.example/'], ['/\r/evil.example/'],
    ['/..//evil.example/'], ['/.//evil.example'], ['/a/../..//evil.example'], ['/%2e%2e//evil.example/'],
    ['//'], ['///'], ['//['], ['/' + 'a'.repeat(3000)],
  ])('rejects returnTo %s', async (rt) => {
    const r = await t.app.inject(`/auth/login?returnTo=${encodeURIComponent(rt)}`);
    const attempt = t.db.prepare('SELECT return_to FROM login_attempts ORDER BY rowid DESC LIMIT 1').get() as { return_to: string };
    expect(r.statusCode).toBe(302);
    expect(attempt.return_to).toBe('/');
  });
  it('redirects to / after a full login with a dot-segment returnTo', async () => {
    const start = await t.app.inject(`/auth/login?login_hint=testuser&returnTo=${encodeURIComponent('/..//evil.example/')}`);
    const cookie = String(start.headers['set-cookie']).split(';')[0]!;
    const idp = await fetch(String(start.headers.location), { redirect: 'manual' });
    const back = new URL(idp.headers.get('location')!);
    const cb = await t.app.inject({ url: back.pathname + back.search, headers: { cookie } });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/');
  });
  it('keeps a same-origin relative returnTo', async () => {
    await t.app.inject(`/auth/login?returnTo=${encodeURIComponent('/Fotos?x=1')}`);
    const attempt = t.db.prepare('SELECT return_to FROM login_attempts ORDER BY rowid DESC LIMIT 1').get() as { return_to: string };
    expect(attempt.return_to).toBe('/Fotos?x=1');
  });
});

describe('sessions', () => {
  it('logout deletes the session server-side', async () => {
    const s = await login(t);
    const out = await t.app.inject({ method: 'POST', url: '/auth/logout',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: 'https://files.example.com' } });
    expect(out.statusCode).toBe(204);
    const cleared = ([] as string[]).concat(out.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${names().sid}=`));
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(new RegExp(`^${names().sid}=;`));
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect(cleared).toMatch(/Path=\/(;|$)/);
    expect((await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).statusCode).toBe(401);
  });
  it('an expired session is rejected', async () => {
    const s = await login(t);
    t.db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json()).toEqual({ code: 'UNAUTHENTICATED' });
  });
});

describe('CSRF', () => {
  it('rejects a mutating request without the token', async () => {
    const s = await login(t);
    const r = await t.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: s.cookie, origin: 'https://files.example.com' } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ code: 'CSRF' });
  });
  it('rejects a present but wrong same-length token and a token prefix', async () => {
    const s = await login(t);
    const send = (tok: string) => t.app.inject({ method: 'POST', url: '/auth/logout',
      headers: { cookie: s.cookie, 'x-csrf-token': tok, origin: 'https://files.example.com' } });
    const wrong = s.csrf.replace(/./g, 'x');
    expect(wrong).toHaveLength(s.csrf.length);
    expect((await send(wrong)).json()).toEqual({ code: 'CSRF' });
    expect((await send(s.csrf.slice(0, s.csrf.length / 2))).statusCode).toBe(403);
  });
  it('rejects a mutating request from a foreign origin even with the token', async () => {
    const s = await login(t);
    const r = await t.app.inject({ method: 'POST', url: '/auth/logout',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: 'https://calendar.example.com' } });
    expect(r.statusCode).toBe(403);
  });
});

// shard_core sends no role claim yet (freeshard#251): without the claim config nobody is admin.
describe('OIDC login without an admin claim config', () => {
  it('maps the IdP admin test user to member', async () => {
    const u = await startTestApp({ FILES_OIDC_ROLE_CLAIM: undefined, FILES_OIDC_ADMIN_VALUE: undefined });
    try {
      const s = await login(u, 'testuser');
      const r = await u.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ email: 'testuser@example.com', role: 'member' });
    } finally {
      await u.close();
    }
  });
});
