import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// #218: "Two panes" is a setting of each member, off by default, stored on the server beside language, theme and sort
// and written on its own (`PUT /api/v1/settings/layout`), so it follows the member to every device.

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

describe('two panes setting', () => {
  it('is off before anything is saved, also in /me', async () => {
    const r = await as(m, 'GET', '/api/v1/settings/layout');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().dualPane).toBe(false);
    expect((await as(m, 'GET', '/api/v1/me')).json().layout.dualPane).toBe(false);
  });

  it('is saved per member, served to a second session, and leaves language, theme and sort alone', async () => {
    await as(a, 'PUT', '/api/v1/settings', { locale: 'en', theme: 'dark' });
    await as(a, 'PUT', '/api/v1/settings/sort', { key: 'size', dir: 'desc' });
    const r = await as(a, 'PUT', '/api/v1/settings/layout', { dualPane: true, tabs: false });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ dualPane: true, tabs: false });
    const other = await login(t, 'testuser'); // another device
    expect((await as(other, 'GET', '/api/v1/me')).json()).toMatchObject({ layout: { dualPane: true, tabs: false },
      settings: { locale: 'en', theme: 'dark' }, sort: { key: 'size', dir: 'desc' } });
    // Another member keeps theirs; a settings save keeps the layout.
    expect((await as(m, 'GET', '/api/v1/settings/layout')).json().dualPane).toBe(false);
    await as(a, 'PUT', '/api/v1/settings', { locale: null, theme: 'system' });
    expect((await as(a, 'GET', '/api/v1/settings/layout')).json().dualPane).toBe(true);
    // Turned off again.
    expect((await as(a, 'PUT', '/api/v1/settings/layout', { dualPane: false, tabs: false })).json().dualPane).toBe(false);
    expect((await as(a, 'GET', '/api/v1/me')).json().layout.dualPane).toBe(false);
  });

  it('a member whose first write is the layout gets the other defaults', async () => {
    const fresh = await login(t, 'member2');
    await as(fresh, 'PUT', '/api/v1/settings/layout', { dualPane: true, tabs: false });
    expect((await as(fresh, 'GET', '/api/v1/me')).json()).toMatchObject({ layout: { dualPane: true },
      settings: { locale: null, theme: 'system' }, sort: { key: 'name', dir: 'asc' } });
  });

  it.each([
    [{ dualPane: 'yes', tabs: false }],
    [{ dualPane: 1, tabs: false }],
    [{ tabs: false }],
    [{ dualPane: true, tabs: false, extra: 1 }],
  ])('refuses %j with VALIDATION and stores nothing', async (body) => {
    await as(a, 'PUT', '/api/v1/settings/layout', { dualPane: true, tabs: false });
    const r = await as(a, 'PUT', '/api/v1/settings/layout', body);
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().code).toBe('VALIDATION');
    expect((await as(a, 'GET', '/api/v1/settings/layout')).json().dualPane).toBe(true);
  });

  it('needs a session and a CSRF token', async () => {
    expect((await t.app.inject({ url: '/api/v1/settings/layout' })).statusCode).toBe(401);
    const r = await t.app.inject({ method: 'PUT', url: '/api/v1/settings/layout', headers: { cookie: a.cookie, origin: ORIGIN },
      payload: { dualPane: true, tabs: false } });
    expect(r.statusCode).toBe(403);
  });
});
