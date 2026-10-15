import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyRequest, RouteOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { homeRoot } from '../src/paths.ts';
import { getUser, type User } from '../src/users.ts';
import { resolveSource } from '../src/storage/resolveSource.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// Pass-through spy: the real resolver runs unless a test overrides it, so every route's call is observable.
vi.mock('../src/storage/resolveSource.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/storage/resolveSource.ts')>();
  return { ...real, resolveSource: vi.fn(real.resolveSource) };
});
const spy = vi.mocked(resolveSource);
const realResolve = spy.getMockImplementation()!;

let t: TestApp; let a: { cookie: string; csrf: string }; let m: { cookie: string; csrf: string };
let admin: User; let member: User;
const ORIGIN = 'https://files.example.com';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const userOf = async (s: { cookie: string }) =>
  getUser(t.db, (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id)!;
// What resolveSource reads from a request: the authenticated user and session, and the app's deps.
const reqAs = (user: User) => ({ user, session: { idHash: 'x', csrfToken: 'x' }, server: t.app }) as unknown as FastifyRequest;
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);

beforeAll(async () => {
  t = await startTestApp();
  a = await login(t, 'testuser'); m = await login(t, 'member');
  admin = await userOf(a); member = await userOf(m);
});
afterAll(() => t.close());
afterEach(() => { spy.mockImplementation(realResolve); spy.mockClear(); });

describe('resolveSource', () => {
  it('resolves home to the caller\'s own home with edit access', async () => {
    const r = await resolveSource(reqAs(member), 'home');
    expect(r.access).toBe('edit');
    await r.backend.write('/mine.txt', Readable.from([Buffer.from('member data')]), { onCollision: 'fail', maxBytes: 1024 });
    expect(readFileSync(join(homeRoot(t.config.dataDir, member.id), 'mine.txt'), 'utf8')).toBe('member data');
    expect(existsSync(join(homeRoot(t.config.dataDir, admin.id), 'mine.txt'))).toBe(false);
  });

  it.each([
    ['another user\'s id', () => member.id],
    ['home scoped to another user', () => `home:${member.id}`],
    ['a connection (until #148)', () => 'conn:x'],
    ['a share (until #146)', () => 'share:x'],
    ['an empty connection id', () => 'conn:'],
    ['an empty source', () => ''],
    ['a differently cased home', () => 'HOME'],
    ['home with a suffix', () => 'home/..'],
    ['an unknown kind', () => 'drive:x'],
  ])('rejects %s with SOURCE_NOT_FOUND, never falling back to home', async (_label, source) => {
    expect(await codeOf(resolveSource(reqAs(admin), source()))).toBe('SOURCE_NOT_FOUND');
  });

  it('answers 404 SOURCE_NOT_FOUND over HTTP for a foreign or unknown source', async () => {
    for (const source of [member.id, 'conn:x', 'share:x']) {
      const r = await t.app.inject({ url: `/api/v1/sources/${encodeURIComponent(source)}/list?path=%2F`, headers: { cookie: a.cookie } });
      expect(r.statusCode, source).toBe(404);
      expect(r.json(), source).toEqual({ code: 'SOURCE_NOT_FOUND' });
    }
  });

  it('requires an authenticated user', async () => {
    const anon = { server: t.app } as unknown as FastifyRequest;
    expect(await codeOf(resolveSource(anon, 'home'))).toBe('UNAUTHENTICATED');
  });
});

// Route-inventory style: walks every registered route under /api/v1/sources/.
type Probe = { method: string; pattern: string; url: string };
const sourceProbes = (routes: RouteOptions[]): Probe[] => routes
  .filter((r) => r.url.startsWith('/api/v1/sources/'))
  .flatMap((r) => ([] as string[]).concat(r.method).map((method) => ({
    method, pattern: r.url,
    url: r.url.replace(':source', 'home').replace(/:[A-Za-z0-9_]+(\([^)]*\))?\??/g, 'sample').replace(/\*/g, 'sample'),
  })));
const inject = (p: Probe, s: { cookie: string; csrf: string }, url = p.url) => t.app.inject({
  method: p.method as 'GET', url,
  headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN,
    ...(SAFE.has(p.method) ? {} : { 'content-type': 'application/octet-stream' }) },
  ...(SAFE.has(p.method) ? {} : { payload: 'x' }),
});

describe('sources routes', () => {
  it('every route under /api/v1/sources/ resolves its source through resolveSource', async () => {
    const probes = sourceProbes(t.routes);
    expect(probes.map((p) => `${p.method} ${p.pattern}`)).toEqual(expect.arrayContaining([
      'GET /api/v1/sources/:source/list', 'GET /api/v1/sources/:source/content', 'PUT /api/v1/sources/:source/content',
      'POST /api/v1/sources/:source/mkdir']));
    for (const p of probes) {
      spy.mockClear();
      await inject(p, a);
      expect(spy, `${p.method} ${p.pattern}`).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![1], `${p.method} ${p.pattern}`).toBe('home');
    }
  });

  it('a mutating route answers 403 FORBIDDEN when the source grants only read', async () => {
    spy.mockImplementation(async (req, source) => ({ ...(await realResolve(req, source)), access: 'read' as const }));
    const mutating = sourceProbes(t.routes).filter((p) => !SAFE.has(p.method));
    expect(mutating.length).toBeGreaterThanOrEqual(2);
    for (const p of mutating) {
      const r = await inject(p, a);
      expect(r.statusCode, `${p.method} ${p.pattern}`).toBe(403);
      expect(r.json(), `${p.method} ${p.pattern}`).toEqual({ code: 'FORBIDDEN' });
    }
  });

  it('read access refuses a well-formed upload and mkdir without touching the disk, but still serves reads', async () => {
    spy.mockImplementation(async (req, source) => ({ ...(await realResolve(req, source)), access: 'read' as const }));
    const h = { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN };
    const up = await t.app.inject({ method: 'PUT', url: '/api/v1/sources/home/content?path=%2Fro.txt&onCollision=fail',
      headers: { ...h, 'content-type': 'application/octet-stream' }, payload: 'nope' });
    expect(up.statusCode).toBe(403);
    const mk = await t.app.inject({ method: 'POST', url: '/api/v1/sources/home/mkdir', headers: h, payload: { path: '/ro-dir' } });
    expect(mk.statusCode).toBe(403);
    const root = homeRoot(t.config.dataDir, admin.id);
    expect(existsSync(join(root, 'ro.txt'))).toBe(false);
    expect(existsSync(join(root, 'ro-dir'))).toBe(false);
    expect((await t.app.inject({ url: '/api/v1/sources/home/list?path=%2F', headers: { cookie: a.cookie } })).statusCode).toBe(200);
  });
});
