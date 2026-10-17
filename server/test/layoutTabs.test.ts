import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// #219: "Tabs" is a setting of each member, off by default, stored on the server with "Two panes" (#218). Which tabs
// are open is not stored here: that stays on each device.

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

describe('tabs setting', () => {
  it('is off before anything is saved, also in /me', async () => {
    const r = await as(m, 'GET', '/api/v1/settings/layout');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().tabs).toBe(false);
    expect((await as(m, 'GET', '/api/v1/me')).json().layout.tabs).toBe(false);
  });

  it('is saved per member, independent of two panes, and served to a second session', async () => {
    const r = await as(a, 'PUT', '/api/v1/settings/layout', { dualPane: false, tabs: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ dualPane: false, tabs: true });
    const other = await login(t, 'testuser');
    expect((await as(other, 'GET', '/api/v1/me')).json().layout).toEqual({ dualPane: false, tabs: true });
    expect((await as(m, 'GET', '/api/v1/me')).json().layout.tabs).toBe(false);
    // Both together, then tabs off with two panes kept.
    expect((await as(a, 'PUT', '/api/v1/settings/layout', { dualPane: true, tabs: true })).json()).toEqual({ dualPane: true, tabs: true });
    expect((await as(a, 'PUT', '/api/v1/settings/layout', { dualPane: true, tabs: false })).json()).toEqual({ dualPane: true, tabs: false });
    expect((await as(a, 'GET', '/api/v1/settings/layout')).json()).toEqual({ dualPane: true, tabs: false });
  });

  it.each([
    [{ dualPane: false, tabs: 'on' }],
    [{ dualPane: false }],
    [{ dualPane: false, tabs: null }],
  ])('refuses %j with VALIDATION and stores nothing', async (body) => {
    await as(a, 'PUT', '/api/v1/settings/layout', { dualPane: false, tabs: true });
    const r = await as(a, 'PUT', '/api/v1/settings/layout', body);
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().code).toBe('VALIDATION');
    expect((await as(a, 'GET', '/api/v1/settings/layout')).json().tabs).toBe(true);
  });
});
