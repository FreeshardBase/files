import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, login, type TestApp } from './support/harness.ts';

let t: TestApp;
beforeAll(async () => { t = await startTestApp(); });
afterAll(() => t.close());

describe('deny by default', () => {
  it('rejects /api/v1/me without a session', async () => {
    const r = await t.app.inject('/api/v1/me');
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ code: 'UNAUTHENTICATED' });
  });
  it('rejects an unknown route under /api with 401, not 404', async () => {
    expect((await t.app.inject('/api/v1/does-not-exist')).statusCode).toBe(401);
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
  it('rejects a callback whose state does not match', async () => {
    const start = await t.app.inject('/auth/login');
    const loginCookie = String(start.headers['set-cookie']);
    const r = await t.app.inject({ url: '/auth/callback?code=x&state=forged', headers: { cookie: loginCookie } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ code: 'LOGIN_FAILED' });
  });
  it('rejects a callback without a login cookie even if state is supplied', async () => {
    const r = await t.app.inject('/auth/callback?code=x&state=anything');
    expect(r.statusCode).toBe(400);
  });
  it('only allows same-origin relative returnTo', async () => {
    const r = await t.app.inject('/auth/login?returnTo=https://evil.example/');
    const attempt = t.db.prepare('SELECT return_to FROM login_attempts ORDER BY rowid DESC LIMIT 1').get() as { return_to: string };
    expect(r.statusCode).toBe(302);
    expect(attempt.return_to).toBe('/');
  });
});

describe('sessions', () => {
  it('logout deletes the session server-side', async () => {
    const s = await login(t);
    const out = await t.app.inject({ method: 'POST', url: '/auth/logout',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: 'https://files.example.com' } });
    expect(out.statusCode).toBe(204);
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
  it('rejects a mutating request from a foreign origin even with the token', async () => {
    const s = await login(t);
    const r = await t.app.inject({ method: 'POST', url: '/auth/logout',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: 'https://calendar.example.com' } });
    expect(r.statusCode).toBe(403);
  });
});
