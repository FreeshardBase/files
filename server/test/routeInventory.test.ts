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
  // Routes added by a later feature outside /api and /auth without `public`.
  t = await startTestApp({}, (app) => {
    app.get('/later/*', async () => ({ later: true }));
    app.put('/s/:token', async () => ({ share: true }));
  });
  s = await login(t);
});
afterAll(async () => { delete process.env.FILES_WEB_DIST; await t.close(); rmSync(dist, { recursive: true, force: true }); });

type Probe = { method: string; pattern: string; url: string; isPublic: boolean; isDav: boolean };
const probes = (routes: RouteOptions[]): Probe[] => routes.flatMap((r) =>
  ([] as string[]).concat(r.method).map((method) => ({
    method, pattern: r.url,
    // A concrete URL for the pattern: every parameter and wildcard gets a sample value.
    url: r.url.replace(/:[A-Za-z0-9_]+(\([^)]*\))?\??/g, 'sample').replace(/\*/g, 'sample'),
    isPublic: r.config?.public === true,
    isDav: r.config?.appPassword === true,
  })));

describe('route inventory', () => {
  it('collects the real route table, including routes added by extend', () => {
    const patterns = t.routes.map((r) => r.url);
    expect(patterns).toEqual(expect.arrayContaining(['/api/v1/me', '/auth/logout', '/api/v1/sources/:source/content', '/later/*', '/s/:token',
      '/dav', '/dav/*', '/api/v1/app-passwords']));
  });

  // Every public route and why it may be reached without a session.
  const PUBLIC: Record<string, string> = {
    '/healthz': 'container health check',
    '/auth/login': 'starts the OIDC login',
    '/auth/callback': 'the OIDC provider redirects back here',
    '/*': 'SPA fallback (index.html; also the public share page /s/<token>)',
    '/': 'static asset', '/index.html': 'static asset', '/assets/app.js': 'static asset',
    '/s/:token/*': 'public links (#147): visitors have no session; token, password, expiry and download limit guard it',
  };

  it('only the allowlisted routes and the static assets are public', () => {
    const pub = probes(t.routes).filter((p) => p.isPublic).map((p) => p.pattern);
    expect(pub.filter((p) => !(p in PUBLIC))).toEqual([]);
    expect(pub).toEqual(expect.arrayContaining(['/healthz', '/auth/login', '/auth/callback', '/*', '/assets/app.js', '/s/:token/*']));
  });

  it('/s/:token/* is the one public route family of public links, for GET and POST only', () => {
    const links = probes(t.routes).filter((p) => p.pattern.startsWith('/s/'));
    expect(links.filter((p) => p.isPublic).map((p) => `${p.method} ${p.pattern}`).sort()).toEqual(['GET /s/:token/*', 'POST /s/:token/*']);
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
    const mutating = probes(t.routes).filter((p) => !p.isPublic && !p.isDav && !SAFE.has(p.method));
    expect(mutating.map((p) => `${p.method} ${p.pattern}`)).toEqual(expect.arrayContaining(['POST /auth/logout', 'PUT /s/:token']));
    for (const p of mutating) {
      const r = await t.app.inject({ method: p.method as 'POST', url: p.url, headers: { cookie: s.cookie, origin: ORIGIN } });
      expect(r.statusCode, `${p.method} ${p.pattern} (${p.url})`).toBe(403);
      expect(r.json()).toEqual({ code: 'CSRF' });
    }
  });

  // WebDAV (#157) is the one route family that takes app passwords (HTTP Basic) instead of the session, and only them.
  it('the WebDAV routes are exactly /dav and /dav/*, take app passwords only, and answer 401 to a session', async () => {
    const dav = probes(t.routes).filter((p) => p.isDav);
    expect([...new Set(dav.map((p) => p.pattern))].sort()).toEqual(['/dav', '/dav/*']);
    expect(probes(t.routes).filter((p) => p.pattern.startsWith('/dav') && !p.isDav)).toEqual([]);
    expect(dav.filter((p) => p.isPublic)).toEqual([]);
    expect(new Set(dav.map((p) => p.method))).toEqual(new Set(['OPTIONS', 'GET', 'HEAD', 'PUT', 'DELETE', 'PROPFIND', 'PROPPATCH',
      'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK']));
    for (const p of dav) {
      const r = await t.app.inject({ method: p.method as 'GET', url: p.url,
        headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN } });
      expect(r.statusCode, `${p.method} ${p.pattern} (${p.url})`).toBe(401);
      expect(String(r.headers['www-authenticate']), `${p.method} ${p.pattern}`).toMatch(/^Basic /);
    }
  });

  it('an extend-registered GET /later/* and PUT /s/:token are closed without a session', async () => {
    expect((await t.app.inject('/later/some/file.txt')).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'PUT', url: '/s/abc', headers: { origin: ORIGIN }, payload: 'x' })).statusCode).toBe(401);
  });

  it('keeps static assets and the SPA shell reachable without a session', async () => {
    expect((await t.app.inject('/assets/app.js')).statusCode).toBe(200);
    expect((await t.app.inject('/home/deep')).body).toContain('SPA-SHELL');
  });
});
