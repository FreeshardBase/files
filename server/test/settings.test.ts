import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// #159: a member's language and theme live in one row on the server, so the choice follows them to every device.
// Nobody has a row until they save: the defaults are "no language chosen" (the client then resolves platform >
// browser > Deutsch (Du)) and the system theme. Only the caller's own row is ever read or written.

type S = { cookie: string; csrf: string };
const ORIGIN = 'https://files.example.com';
let t: TestApp; let a: S; let m: S;

beforeAll(async () => {
  t = await startTestApp();
  a = await login(t, 'testuser');
  m = await login(t, 'member');
});
afterAll(async () => { await t?.close(); });

const as = (s: S, method: 'GET' | 'PUT', url: string, payload?: unknown) => t.app.inject({
  method, url, headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': s.csrf }) },
  ...(payload !== undefined ? { payload: payload as object } : {}),
});

describe('settings', () => {
  it('has the defaults before anything is saved, also in /me', async () => {
    const r = await as(m, 'GET', '/api/v1/settings');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ locale: null, theme: 'system' });
    expect((await as(m, 'GET', '/api/v1/me')).json().settings).toEqual({ locale: null, theme: 'system' });
  });

  it('saves language and theme, returns them, and serves them in /me to a second session', async () => {
    const r = await as(a, 'PUT', '/api/v1/settings', { locale: 'de-sie', theme: 'dark' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ locale: 'de-sie', theme: 'dark' });
    // Another device: a fresh sign-in of the same member.
    const other = await login(t, 'testuser');
    expect((await as(other, 'GET', '/api/v1/settings')).json()).toEqual({ locale: 'de-sie', theme: 'dark' });
    expect((await as(other, 'GET', '/api/v1/me')).json().settings).toEqual({ locale: 'de-sie', theme: 'dark' });

    // Saving again replaces the row; null takes the language choice back.
    expect((await as(a, 'PUT', '/api/v1/settings', { locale: 'en', theme: 'light' })).json()).toEqual({ locale: 'en', theme: 'light' });
    expect((await as(a, 'PUT', '/api/v1/settings', { locale: null, theme: 'system' })).json()).toEqual({ locale: null, theme: 'system' });
    expect((await as(a, 'GET', '/api/v1/settings')).json()).toEqual({ locale: null, theme: 'system' });
  });

  it('keeps every member to their own row', async () => {
    await as(a, 'PUT', '/api/v1/settings', { locale: 'en', theme: 'dark' });
    expect((await as(m, 'GET', '/api/v1/settings')).json()).toEqual({ locale: null, theme: 'system' });
    await as(m, 'PUT', '/api/v1/settings', { locale: 'de-du', theme: 'light' });
    expect((await as(a, 'GET', '/api/v1/settings')).json()).toEqual({ locale: 'en', theme: 'dark' });
  });

  it.each([
    [{ locale: 'fr', theme: 'dark' }],
    [{ locale: 'en', theme: 'sepia' }],
    [{ locale: 'en' }],
    [{ theme: 'dark' }],
    [{ locale: 'en', theme: 'dark', extra: 1 }],
  ])('refuses %j with VALIDATION and stores nothing', async (body) => {
    await as(a, 'PUT', '/api/v1/settings', { locale: 'de-du', theme: 'light' });
    const r = await as(a, 'PUT', '/api/v1/settings', body);
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().code).toBe('VALIDATION');
    expect((await as(a, 'GET', '/api/v1/settings')).json()).toEqual({ locale: 'de-du', theme: 'light' });
  });

  // #226: the folder sort follows the member like language and theme, but is written on its own.
  it('sort: name ascending before any change, also in /me', async () => {
    const fresh = await login(t, 'member2');
    expect((await as(fresh, 'GET', '/api/v1/settings/sort')).json()).toEqual({ key: 'name', dir: 'asc' });
    expect((await as(fresh, 'GET', '/api/v1/me')).json().sort).toEqual({ key: 'name', dir: 'asc' });
  });

  it('sort: saved per member, served to a second session, and leaves language and theme alone', async () => {
    await as(a, 'PUT', '/api/v1/settings', { locale: 'de-sie', theme: 'dark' });
    const r = await as(a, 'PUT', '/api/v1/settings/sort', { key: 'size', dir: 'desc' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ key: 'size', dir: 'desc' });
    const other = await login(t, 'testuser');
    expect((await as(other, 'GET', '/api/v1/me')).json()).toMatchObject({ settings: { locale: 'de-sie', theme: 'dark' },
      sort: { key: 'size', dir: 'desc' } });
    // A settings save keeps the sort; another member keeps theirs.
    await as(a, 'PUT', '/api/v1/settings', { locale: 'en', theme: 'light' });
    expect((await as(a, 'GET', '/api/v1/settings/sort')).json()).toEqual({ key: 'size', dir: 'desc' });
    expect((await as(m, 'GET', '/api/v1/settings/sort')).json()).toEqual({ key: 'name', dir: 'asc' });
    // A member whose first write is the sort gets the settings defaults.
    const fresh = await login(t, 'member2');
    await as(fresh, 'PUT', '/api/v1/settings/sort', { key: 'modified', dir: 'asc' });
    expect((await as(fresh, 'GET', '/api/v1/me')).json()).toMatchObject({ settings: { locale: null, theme: 'system' },
      sort: { key: 'modified', dir: 'asc' } });
    await as(a, 'PUT', '/api/v1/settings/sort', { key: 'name', dir: 'asc' });
  });

  it.each([
    [{ key: 'type', dir: 'asc' }],
    [{ key: 'name', dir: 'up' }],
    [{ key: 'name' }],
    [{ key: 'name', dir: 'asc', extra: 1 }],
  ])('sort: refuses %j with VALIDATION and stores nothing', async (body) => {
    await as(a, 'PUT', '/api/v1/settings/sort', { key: 'modified', dir: 'desc' });
    const r = await as(a, 'PUT', '/api/v1/settings/sort', body);
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().code).toBe('VALIDATION');
    expect((await as(a, 'GET', '/api/v1/settings/sort')).json()).toEqual({ key: 'modified', dir: 'desc' });
  });

  it('needs a session and a CSRF token', async () => {
    expect((await t.app.inject({ url: '/api/v1/settings' })).statusCode).toBe(401);
    const r = await t.app.inject({ method: 'PUT', url: '/api/v1/settings', headers: { cookie: a.cookie, origin: ORIGIN },
      payload: { locale: 'en', theme: 'dark' } });
    expect(r.statusCode).toBe(403);
  });
});
