import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// Deny by default, enforced over the whole route table: any route that is not explicitly public
// must refuse a request without a session, and a mutating one must refuse a session without CSRF token.
let t: TestApp; let dist: string; let s: { cookie: string; csrf: string };
const ORIGIN = 'https://files.example.com';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'files-web-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>SPA-SHELL</title>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("asset");');
  process.env.FILES_WEB_DIST = dist;
  // Routes added by a later feature outside /api and /auth (WebDAV, public share links) without `public`.
  t = await startTestApp({}, (app) => {
    app.get('/dav/*', async () => ({ dav: true }));
    app.put('/s/:token', async () => ({ share: true }));
  });
  s = await login(t);
});
afterAll(async () => { delete process.env.FILES_WEB_DIST; await t.close(); rmSync(dist, { recursive: true, force: true }); });

type Probe = { method: string; pattern: string; url: string; isPublic: boolean };
const probes = (routes: RouteOptions[]): Probe[] => routes.flatMap((r) =>
  ([] as string[]).concat(r.method).map((method) => ({
    method, pattern: r.url,
    // A concrete URL for the pattern: every parameter and wildcard gets a sample value.
    url: r.url.replace(/:[A-Za-z0-9_]+(\([^)]*\))?\??/g, 'sample').replace(/\*/g, 'sample'),
    isPublic: r.config?.public === true,
  })));

describe('route inventory', () => {
  it('collects the real route table, including routes added by extend', () => {
    const patterns = t.routes.map((r) => r.url);
    expect(patterns).toEqual(expect.arrayContaining(['/api/v1/me', '/auth/logout', '/api/v1/sources/:source/content', '/dav/*', '/s/:token']));
  });

  it('only the allowlisted routes and the static assets are public', () => {
    const allow = new Set(['/healthz', '/auth/login', '/auth/callback', '/*', '/', '/index.html', '/assets/app.js']);
    const pub = probes(t.routes).filter((p) => p.isPublic).map((p) => p.pattern);
    expect(pub.filter((p) => !allow.has(p))).toEqual([]);
    expect(pub).toEqual(expect.arrayContaining(['/healthz', '/auth/login', '/auth/callback', '/*', '/assets/app.js']));
  });

  it('every non-public route answers 401 without a session', async () => {
    const closed = probes(t.routes).filter((p) => !p.isPublic);
    expect(closed.length).toBeGreaterThan(8);
    for (const p of closed) {
      const r = await t.app.inject({ method: p.method as 'GET', url: p.url, headers: { origin: ORIGIN } });
      expect(r.statusCode, `${p.method} ${p.pattern} (${p.url})`).toBe(401);
    }
  });

  it('every non-public mutating route answers 403 CSRF with a session but without token', async () => {
    const mutating = probes(t.routes).filter((p) => !p.isPublic && !SAFE.has(p.method));
    expect(mutating.map((p) => `${p.method} ${p.pattern}`)).toEqual(expect.arrayContaining(['POST /auth/logout', 'PUT /s/:token']));
    for (const p of mutating) {
      const r = await t.app.inject({ method: p.method as 'POST', url: p.url, headers: { cookie: s.cookie, origin: ORIGIN } });
      expect(r.statusCode, `${p.method} ${p.pattern} (${p.url})`).toBe(403);
      expect(r.json()).toEqual({ code: 'CSRF' });
    }
  });

  it('an extend-registered GET /dav/* and PUT /s/:token are closed without a session', async () => {
    expect((await t.app.inject('/dav/some/file.txt')).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'PUT', url: '/s/abc', headers: { origin: ORIGIN }, payload: 'x' })).statusCode).toBe(401);
  });

  it('keeps static assets and the SPA shell reachable without a session', async () => {
    expect((await t.app.inject('/assets/app.js')).statusCode).toBe(200);
    expect((await t.app.inject('/home/deep')).body).toContain('SPA-SHELL');
  });
});
