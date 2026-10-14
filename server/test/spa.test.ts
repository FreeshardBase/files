import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, login, type TestApp } from './support/harness.ts';

let t: TestApp; let dist: string;
beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'files-web-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>SPA-SHELL</title>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("asset");');
  process.env.FILES_WEB_DIST = dist;
  t = await startTestApp();
});
afterAll(async () => { delete process.env.FILES_WEB_DIST; await t.close(); rmSync(dist, { recursive: true, force: true }); });

describe('SPA serving', () => {
  it('serves index.html at / without a session', async () => {
    const r = await t.app.inject('/');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('SPA-SHELL');
  });
  it('serves index.html for a deep client-side link without a session', async () => {
    const r = await t.app.inject('/some/deep/link');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('SPA-SHELL');
  });
  it('serves static assets without a session', async () => {
    const r = await t.app.inject('/assets/app.js');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('asset');
    expect(r.body).not.toContain('SPA-SHELL');
  });
  it('answers an unknown /api path 401 without a session, never index.html', async () => {
    const r = await t.app.inject('/api/v1/nope');
    expect(r.statusCode).toBe(401);
    expect(r.body).not.toContain('SPA-SHELL');
  });
  it('answers an unknown /auth path 401 without a session', async () => {
    const r = await t.app.inject('/auth/nope');
    expect(r.statusCode).toBe(401);
    expect(r.body).not.toContain('SPA-SHELL');
  });
  it('does not let a percent-encoded /api prefix reach index.html', async () => {
    for (const url of ['/%61pi/v1/me', '/api%2Fv1/me', '/%61uth/login']) {
      const r = await t.app.inject(url);
      expect(r.body, url).not.toContain('SPA-SHELL');
    }
    const r = await t.app.inject('/%61pi/v1/me');
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ code: 'UNAUTHENTICATED' });
  });
  it('answers an unknown /api path 404 NOT_FOUND with a session', async () => {
    const s = await login(t);
    const r = await t.app.inject({ url: '/api/v1/nope', headers: { cookie: s.cookie } });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ code: 'NOT_FOUND' });
  });
  it('keeps real API routes working next to the fallback', async () => {
    const s = await login(t);
    const r = await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().id).toBeTruthy();
    expect((await t.app.inject('/healthz')).json()).toEqual({ status: 'ok' });
  });
});
