import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Entry, PublicLink } from '@files/shared';
import type { ConnectedBackend, StorageBackend } from '../src/storage/backend.ts';
import { isExpired } from '../src/storage/publicLinks.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// #147: public links. `testuser` owns the items and the links; visitors have no session at all. Regression tests for
// #104 (`?inline=1` bypassing the limit, expiry failing open, no password rate limit), #95 (falling back to another
// source) and #107 (stored XSS on the share page).

type S = { cookie: string; csrf: string };
let t: TestApp; let owner: S; let other: S; let dist: string;
const ORIGIN = 'https://files.example.com';
const mutating = (s: S) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN });

// `testuser`'s cloud connection `cloud`, present while `linked` is true; its one file is /doc.txt.
let ownerId = ''; let linked = true;
const nope = async (): Promise<never> => { throw new Error('not used by the link test'); };
const cloudEntry = (path: string): Entry => ({ name: 'doc.txt', path, type: 'file', size: 11, modified: '2026-10-01T00:00:00.000Z',
  mime: 'text/plain' });
const cloud: StorageBackend = {
  list: nope, write: nope, mkdir: nope, move: nope, copy: nope, delete: nope,
  stat: async (p) => cloudEntry(p),
  read: async (p) => ({ entry: cloudEntry(p), stream: Readable.from([Buffer.from('cloud bytes')]), etag: '"c1"' }),
};
const connections = async (user: { id: string }): Promise<ConnectedBackend[]> =>
  user.id === ownerId && linked ? [{ id: 'cloud', backend: cloud }] : [];
// Everything the app logs (request lines included), to check that tokens never reach it.
const logLines: string[] = [];
const logStream = new Writable({ write(chunk, _enc, cb) { logLines.push(String(chunk)); cb(); } });

beforeAll(async () => {
  // A built SPA shell, so the share page itself (/s/<token>) is served like in production.
  dist = mkdtempSync(join(tmpdir(), 'files-web-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>SPA-SHELL</title><div id="app"></div>');
  process.env.FILES_WEB_DIST = dist;
  t = await startTestApp({ FILES_MAX_UPLOAD_BYTES: String(1024 ** 2), FILES_LOG_LEVEL: 'info' }, undefined, logStream, { connections });
  owner = await login(t, 'testuser'); other = await login(t, 'member');
  ownerId = (await t.app.inject({ url: '/api/v1/me', headers: { cookie: owner.cookie } })).json().id;
});
afterAll(async () => { delete process.env.FILES_WEB_DIST; await t.close(); rmSync(dist, { recursive: true, force: true }); });
afterEach(() => { vi.useRealTimers(); linked = true; });

const put = (path: string, text: string, onCollision = 'fail') => t.app.inject({
  method: 'PUT', url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=${onCollision}`,
  headers: { ...mutating(owner), 'content-type': 'application/octet-stream' }, payload: Buffer.from(text) });
const op = (name: string, payload: unknown) => t.app.inject({
  method: 'POST', url: `/api/v1/sources/home/${name}`, headers: mutating(owner), payload: payload as object });
const ok = async <R extends { statusCode: number; body: string }>(r: Promise<R>) => {
  const x = await r; expect(x.statusCode, x.body).toBeLessThan(300); return x;
};
const createLink = (payload: Record<string, unknown>, s: S = owner) =>
  t.app.inject({ method: 'POST', url: '/api/v1/links', headers: mutating(s), payload });
async function link(path: string, extra: Record<string, unknown> = {}): Promise<PublicLink> {
  const r = await createLink({ source: 'home', path, ...extra });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
let n = 0;
/** A fresh folder with `files` in it; returns its path. */
async function folder(files: Record<string, string>): Promise<string> {
  const dir = `/links-${++n}`;
  await ok(op('mkdir', { path: dir }));
  for (const [name, text] of Object.entries(files)) await ok(put(`${dir}/${name}`, text));
  return dir;
}
// A visitor: no session cookie, only what the link gave them.
const visit = (token: string, rest: string, init: { cookie?: string; headers?: Record<string, string>; ip?: string } = {}) =>
  t.app.inject({ url: `/s/${token}/${rest}`, remoteAddress: init.ip ?? '198.51.100.7',
    headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers } });
const unlock = (token: string, password: string, ip = '198.51.100.7', headers: Record<string, string> = { origin: ORIGIN }) =>
  t.app.inject({ method: 'POST', url: `/s/${token}/unlock`, remoteAddress: ip, headers, payload: { password } });
const unlockCookie = (r: { headers: Record<string, unknown> }) => {
  const c = String(r.headers['set-cookie']);
  expect(c).toMatch(new RegExp(`Path=/s/[A-Za-z0-9_-]{22}/`));
  expect(c).toMatch(/HttpOnly/); expect(c).toMatch(/Secure/); expect(c).toMatch(/SameSite=Strict/);
  return c.split(';')[0]!;
};
const linksOn = async (path: string) => (await ok(t.app.inject({
  url: `/api/v1/links?source=home&path=${encodeURIComponent(path)}`, headers: { cookie: owner.cookie } }))).json().items;

describe('creating a link', () => {
  it('gets a 128-bit base64url token and is reachable without a session', async () => {
    const dir = await folder({ 'a.txt': 'alpha' });
    const l = await link(`${dir}/a.txt`, { label: 'For the plumber' });
    expect(l.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(l.token, 'base64url')).toHaveLength(16);
    expect(l).toMatchObject({ label: 'For the plumber', expiresAt: null, maxDownloads: null, downloads: 0, hasPassword: false,
      orphaned: false });
    const info = await visit(l.token, 'info');
    expect(info.statusCode, info.body).toBe(200);
    expect(info.json()).toMatchObject({ name: 'a.txt', type: 'file', locked: false, size: 5, downloadsLeft: null });
    const dl = await visit(l.token, 'content');
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('alpha');
    expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
    // Two links to the same item get different tokens.
    expect((await link(`${dir}/a.txt`)).token).not.toBe(l.token);
  });

  it('takes only the caller\'s own items: no share source, not the whole home, no unknown fields', async () => {
    const dir = await folder({ 'a.txt': 'alpha' });
    expect((await createLink({ source: 'share:abc', path: '/a.txt' })).json()).toEqual({ code: 'FORBIDDEN' });
    expect((await createLink({ source: 'home', path: '/' })).json()).toEqual({ code: 'PATH_INVALID' });
    expect((await createLink({ source: 'home', path: `${dir}/a.txt`, owner: 'someone' })).json()).toEqual({ code: 'VALIDATION' });
    expect((await createLink({ source: 'home', path: `${dir}/missing.txt` })).statusCode).toBe(404);
    // The member's own home has no such file: a link is always to the caller's item.
    expect((await createLink({ source: 'home', path: `${dir}/a.txt` }, other)).statusCode).toBe(404);
  });

  it('an unknown or malformed token is 404', async () => {
    expect((await visit('A'.repeat(22), 'info')).json()).toEqual({ code: 'NOT_FOUND' });
    expect((await visit('short', 'info')).json()).toEqual({ code: 'NOT_FOUND' });
  });
});

describe('download limit (#104)', () => {
  it('a limit of 2 allows exactly two byte-serving answers, previews and ranges included', async () => {
    const dir = await folder({ 'note.txt': 'hello world' });
    const l = await link(`${dir}/note.txt`, { maxDownloads: 2 });
    const preview = await visit(l.token, 'content?inline=1');
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-disposition']).toMatch(/^inline;/);
    const ranged = await visit(l.token, 'content?path=%2F&anything=else', { headers: { range: 'bytes=0-4' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.body).toBe('hello');
    for (const q of ['content', 'content?inline=1', 'content?download=1']) {
      const r = await visit(l.token, q);
      expect(r.statusCode, q).toBe(410);
      expect(r.json()).toEqual({ code: 'DOWNLOAD_LIMIT_REACHED' });
    }
    expect((await visit(l.token, 'info')).json().downloadsLeft).toBe(0);
    expect((await linksOn(`${dir}/note.txt`))[0]).toMatchObject({ downloads: 2, maxDownloads: 2 });
  });

  it('0 means no downloads, not unlimited', async () => {
    const dir = await folder({ 'note.txt': 'hello' });
    const l = await link(`${dir}/note.txt`, { maxDownloads: 0 });
    expect((await visit(l.token, 'content')).statusCode).toBe(410);
    expect((await visit(l.token, 'content?inline=1')).statusCode).toBe(410);
  });

  it('a missing file or an unsatisfiable range costs nothing; HEAD serves nothing and counts nothing', async () => {
    const dir = await folder({ 'note.txt': 'hello', 'other.txt': 'x' });
    const l = await link(dir, { maxDownloads: 1 });
    expect((await visit(l.token, 'content?path=%2Fmissing.txt')).statusCode).toBe(404);
    expect((await visit(l.token, 'content?path=%2Fnote.txt', { headers: { range: 'bytes=99-' } })).statusCode).toBe(416);
    const head = await t.app.inject({ method: 'HEAD', url: `/s/${l.token}/content?path=%2Fnote.txt` });
    expect(head.headers['content-disposition']).toBeUndefined();
    const dl = await visit(l.token, 'content?path=%2Fnote.txt');
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('hello');
    expect((await visit(l.token, 'content?path=%2Fother.txt')).statusCode).toBe(410);
  });

  it('a browser navigation that is refused lands on the share page with the error code', async () => {
    const dir = await folder({ 'note.txt': 'hello' });
    const l = await link(`${dir}/note.txt`, { maxDownloads: 0 });
    const r = await visit(l.token, 'content', { headers: { 'sec-fetch-mode': 'navigate' } });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`/s/${l.token}?error=DOWNLOAD_LIMIT_REACHED`);
  });
});

describe('expiry (#104)', () => {
  it('an expiry that cannot be parsed, or lies in the past, is refused at creation and never means "never"', async () => {
    const dir = await folder({ 'a.txt': 'alpha' });
    for (const expiresAt of ['tomorrow', '', 'not a date', '2030-13-45T00:00:00Z', '2030-01-01T00:00:00', 1893456000000,
      '2020-01-01T00:00:00Z', true, {}]) {
      const r = await createLink({ source: 'home', path: `${dir}/a.txt`, expiresAt });
      expect(r.statusCode, JSON.stringify(expiresAt)).toBe(400);
      expect(r.json()).toEqual({ code: 'INVALID_EXPIRY' });
    }
    expect(await linksOn(`${dir}/a.txt`)).toEqual([]);
    const l = await link(`${dir}/a.txt`, { expiresAt: '2099-01-01T12:00:00+02:00' });
    expect((await linksOn(`${dir}/a.txt`))[0].expiresAt).toBe('2099-01-01T10:00:00.000Z');
    const bad = await t.app.inject({ method: 'PATCH', url: `/api/v1/links/${l.id}`, headers: mutating(owner), payload: { expiresAt: 'soon' } });
    expect(bad.json()).toEqual({ code: 'INVALID_EXPIRY' });
    expect((await linksOn(`${dir}/a.txt`))[0].expiresAt).toBe('2099-01-01T10:00:00.000Z');
  });

  it('an expired link answers 410 on every route', async () => {
    const dir = await folder({ 'a.txt': 'alpha' });
    const l = await link(`${dir}/a.txt`, { expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    expect((await visit(l.token, 'content')).statusCode).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    for (const rest of ['info', 'content', 'content?inline=1', 'list']) {
      const r = await visit(l.token, rest);
      expect(r.statusCode, rest).toBe(410);
      expect(r.json()).toEqual({ code: 'LINK_EXPIRED' });
    }
    expect((await unlock(l.token, 'x')).json()).toEqual({ code: 'LINK_EXPIRED' });
  });

  // #256: `parseExpiry` validates on write, so only a corrupted or hand-edited row gets here; it must not mean "never".
  it('an expiry that cannot be read counts as expired (fails closed)', () => {
    expect(isExpired({ expires_at: 'garbage' })).toBe(true);
    expect(isExpired({ expires_at: '' })).toBe(true);
    expect(isExpired({ expires_at: '2099-01-01T00:00:00.000Z' })).toBe(false);
    expect(isExpired({ expires_at: null })).toBe(false);
  });
});

describe('logging (#256)', () => {
  it('a visit writes the path to the log with the token masked', async () => {
    const dir = await folder({ 'a.txt': 'alpha' });
    const l = await link(`${dir}/a.txt`);
    logLines.length = 0;
    expect((await visit(l.token, 'info')).statusCode).toBe(200);
    expect((await visit(l.token, 'content?path=%2F')).statusCode).toBe(200);
    const log = logLines.join('');
    expect(log).toContain('"/s/<token>/info"'); // the request was logged, so the absence below is not vacuous
    expect(log).toContain('"/s/<token>/content"');
    expect(log).not.toContain(l.token);
  });
});

describe('password (#104)', () => {
  it('locks the link: only name and type before the password, no bytes, no listing', async () => {
    const dir = await folder({ 'a.txt': 'alpha' });
    const l = await link(dir, { password: 'correct horse' });
    expect(l.hasPassword).toBe(true);
    expect((await visit(l.token, 'info')).json()).toEqual({ name: dir.slice(1), type: 'directory', locked: true });
    expect((await visit(l.token, 'list')).json()).toEqual({ code: 'PASSWORD_REQUIRED' });
    expect((await visit(l.token, 'content?path=%2Fa.txt')).json()).toEqual({ code: 'PASSWORD_REQUIRED' });
    // The hash is argon2id, never the password.
    const stored = t.db.prepare('SELECT password_hash FROM public_links WHERE id = ?').pluck().get(l.id) as string;
    expect(stored).toMatch(/^\$argon2id\$/);
    expect(stored).not.toContain('correct horse');

    const good = await unlock(l.token, 'correct horse');
    expect(good.statusCode, good.body).toBe(204);
    const cookie = unlockCookie(good);
    expect((await visit(l.token, 'info', { cookie })).json()).toMatchObject({ locked: false, type: 'directory' });
    expect((await visit(l.token, 'list', { cookie })).json().entries.map((e: Entry) => e.path)).toEqual(['/a.txt']);
    expect((await visit(l.token, 'content?path=%2Fa.txt', { cookie })).body).toBe('alpha');
  });

  it('the 6th wrong password within the window answers 429 for that token, even a correct one; after the window it works', async () => {
    const dir = await folder({ 'a.txt': 'alpha' });
    const l = await link(`${dir}/a.txt`, { password: 'correct horse' });
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    for (let i = 0; i < 5; i++) expect((await unlock(l.token, `wrong ${i}`, '203.0.113.1')).json()).toEqual({ code: 'PASSWORD_WRONG' });
    const sixth = await unlock(l.token, 'wrong 5', '203.0.113.1');
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toEqual({ code: 'TOO_MANY_ATTEMPTS' });
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
    expect((await unlock(l.token, 'correct horse', '203.0.113.1')).statusCode).toBe(429);
    // Per token: another address is refused for this link too.
    expect((await unlock(l.token, 'correct horse', '203.0.113.2')).statusCode).toBe(429);
    vi.setSystemTime(start + 14 * 60_000);
    expect((await unlock(l.token, 'correct horse', '203.0.113.1')).statusCode).toBe(429);
    vi.setSystemTime(start + 16 * 60_000);
    const good = await unlock(l.token, 'correct horse', '203.0.113.1');
    expect(good.statusCode, good.body).toBe(204);
    expect((await visit(l.token, 'content', { cookie: unlockCookie(good) })).body).toBe('alpha');
  });

  it('per address: 20 wrong passwords across links block that address for every link', async () => {
    const dir = await folder({ 'a.txt': 'alpha' });
    const ls = [];
    for (let i = 0; i < 6; i++) ls.push(await link(`${dir}/a.txt`, { password: 'pw' }));
    for (const l of ls.slice(0, 5)) for (let i = 0; i < 4; i++) expect((await unlock(l.token, 'nope', '203.0.113.50')).statusCode).toBe(403);
    expect((await unlock(ls[5]!.token, 'pw', '203.0.113.50')).statusCode).toBe(429);
    expect((await unlock(ls[5]!.token, 'pw', '203.0.113.51')).statusCode).toBe(204);
  });

  const codeOf = (r: { statusCode: number; json: () => { code: string } }) => (r.statusCode === 204 ? 'UNLOCKED' : r.json().code);
  // #196: the check and the count are one step. Without that, a burst all passes the check before argon2 has settled a
  // single guess, and any number of guesses get through.
  it('a burst of parallel guesses at one token gets 5 password checks; the rest, a correct one included, are 429', async () => {
    const dir = await folder({ 'a.txt': 'alpha' });
    const l = await link(`${dir}/a.txt`, { password: 'correct horse' });
    const rs = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      unlock(l.token, i === 39 ? 'correct horse' : `wrong ${i}`, `192.0.2.${i + 1}`)));
    const codes = rs.map(codeOf);
    expect(codes.filter((c) => c === 'PASSWORD_WRONG')).toHaveLength(5);
    expect(codes.filter((c) => c === 'TOO_MANY_ATTEMPTS')).toHaveLength(35);
    expect(rs[39]!.statusCode).toBe(429);
  });

  it('a burst of parallel guesses from one address across links gets 20 password checks; the rest are 429', async () => {
    const dir = await folder({ 'a.txt': 'alpha' });
    const ls = [];
    for (let i = 0; i < 9; i++) ls.push(await link(`${dir}/a.txt`, { password: 'pw' }));
    // 4 per link stays under the per-link limit: only the per-address one can stop this burst.
    const guesses = ls.slice(0, 8).flatMap((l) => Array.from({ length: 4 }, () => unlock(l.token, 'nope', '198.51.100.200')));
    const rs = await Promise.all([...guesses, unlock(ls[8]!.token, 'pw', '198.51.100.200')]);
    const codes = rs.map(codeOf);
    expect(codes.filter((c) => c === 'PASSWORD_WRONG')).toHaveLength(20);
    expect(codes.filter((c) => c === 'TOO_MANY_ATTEMPTS')).toHaveLength(13);
    expect(rs[32]!.statusCode).toBe(429);
  });

  it('a correct password releases its reserved attempt: it never counts against the link', async () => {
    const dir = await folder({ 'a.txt': 'alpha' });
    const l = await link(`${dir}/a.txt`, { password: 'correct horse' });
    for (let i = 0; i < 4; i++) expect((await unlock(l.token, `wrong ${i}`, '192.0.2.100')).statusCode).toBe(403);
    for (let i = 0; i < 3; i++) expect((await unlock(l.token, 'correct horse', '192.0.2.100')).statusCode).toBe(204);
    expect((await unlock(l.token, 'wrong 4', '192.0.2.100')).statusCode).toBe(403);
    expect((await unlock(l.token, 'correct horse', '192.0.2.100')).statusCode).toBe(429);
  });

  it('the unlock cookie holds for its link only and dies with a password change; no cross-site unlock', async () => {
    const dir = await folder({ 'a.txt': 'alpha' });
    const a = await link(`${dir}/a.txt`, { password: 'same' });
    const b = await link(`${dir}/a.txt`, { password: 'same' });
    const cookie = unlockCookie(await unlock(a.token, 'same'));
    expect((await visit(a.token, 'content', { cookie })).statusCode).toBe(200);
    expect((await visit(b.token, 'content', { cookie })).json()).toEqual({ code: 'PASSWORD_REQUIRED' });
    const forged = cookie.replace(/=([^.]+)\./, '=x.');
    expect((await visit(a.token, 'content', { cookie: forged })).json()).toEqual({ code: 'PASSWORD_REQUIRED' });
    await ok(t.app.inject({ method: 'PATCH', url: `/api/v1/links/${a.id}`, headers: mutating(owner), payload: { password: 'new one' } }));
    expect((await visit(a.token, 'content', { cookie })).json()).toEqual({ code: 'PASSWORD_REQUIRED' });
    expect((await unlock(a.token, 'new one', '198.51.100.7', {})).json()).toEqual({ code: 'CSRF' });
    expect((await unlock(a.token, 'new one', '198.51.100.7', { origin: 'https://evil.example' })).json()).toEqual({ code: 'CSRF' });
    // Removing the password opens the link.
    await ok(t.app.inject({ method: 'PATCH', url: `/api/v1/links/${a.id}`, headers: mutating(owner), payload: { password: null } }));
    expect((await visit(a.token, 'content')).body).toBe('alpha');
  });

  // #256: the server checks the expiry inside the signed cookie; the browser's Max-Age alone would let a copied one live on.
  it('the unlock cookie expires on the server after 60 minutes', async () => {
    const dir = await folder({ 'a.txt': 'alpha' });
    const l = await link(`${dir}/a.txt`, { password: 'correct horse' });
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const cookie = unlockCookie(await unlock(l.token, 'correct horse', '192.0.2.150'));
    vi.setSystemTime(start + 59 * 60_000);
    expect((await visit(l.token, 'content', { cookie })).body).toBe('alpha');
    vi.setSystemTime(start + 61 * 60_000);
    const r = await visit(l.token, 'content', { cookie });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ code: 'PASSWORD_REQUIRED' });
    expect((await visit(l.token, 'info', { cookie })).json()).toMatchObject({ locked: true });
  });
});

describe('orphaned links (#95)', () => {
  it('a deleted target answers 410 and never serves the item that takes its name', async () => {
    const dir = await folder({ 'a.txt': 'original' });
    const l = await link(`${dir}/a.txt`);
    const folderLink = await link(dir);
    await ok(op('delete', { paths: [`${dir}/a.txt`] }));
    await ok(put(`${dir}/a.txt`, 'IMPOSTOR'));
    for (const rest of ['info', 'content', 'content?inline=1']) {
      const r = await visit(l.token, rest);
      expect(r.statusCode, rest).toBe(410);
      expect(r.json()).toEqual({ code: 'SHARE_ORPHANED' });
      expect(r.body).not.toContain('IMPOSTOR');
    }
    expect((await linksOn(`${dir}/a.txt`))[0]).toMatchObject({ id: l.id, orphaned: true });
    // The folder link still works: only what was deleted is orphaned.
    expect((await visit(folderLink.token, 'content?path=%2Fa.txt')).body).toBe('IMPOSTOR');
    await ok(op('delete', { paths: [dir] }));
    expect((await visit(folderLink.token, 'list')).statusCode).toBe(410);
  });

  it('follows a move of the item or a folder above it', async () => {
    const dir = await folder({ 'a.txt': 'moving' });
    const l = await link(`${dir}/a.txt`);
    await ok(op('move', { from: `${dir}/a.txt`, to: `${dir}/b.txt`, onCollision: 'fail' }));
    await ok(op('move', { from: dir, to: `${dir}-moved`, onCollision: 'fail' }));
    expect((await visit(l.token, 'info')).json()).toMatchObject({ name: 'b.txt' });
    expect((await visit(l.token, 'content')).body).toBe('moving');
  });

  it('an unlinked connection answers 410 and never falls back to the home', async () => {
    await ok(put('/doc.txt', 'HOME BYTES', 'replace'));
    // No connection can be linked through the API yet (#148); the row is what a link to one looks like.
    const token = 'C'.repeat(22);
    t.db.prepare(`INSERT INTO public_links (id, token, owner_id, source, path, type, label, created_at)
      VALUES (?, ?, ?, 'conn:cloud', '/doc.txt', 'file', '', ?)`).run('c'.repeat(32), token, ownerId, new Date().toISOString());
    expect((await visit(token, 'content')).body).toBe('cloud bytes');
    linked = false;
    for (const rest of ['info', 'content']) {
      const r = await visit(token, rest);
      expect(r.statusCode, rest).toBe(410);
      expect(r.json()).toEqual({ code: 'SHARE_ORPHANED' });
      expect(r.body).not.toContain('HOME BYTES');
    }
  });
});

describe('share page and content safety (#107)', () => {
  const evil = '<img src=x onerror=alert(1)>.txt';

  it('the page is the static SPA shell under a strict CSP; the name only ever travels as JSON data', async () => {
    const dir = await folder({ [evil]: 'payload' });
    const l = await link(`${dir}/${evil}`, { password: 'pw' });
    const page = await t.app.inject({ url: `/s/${l.token}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.body).toContain('SPA-SHELL');
    expect(page.body).not.toContain('onerror');
    const csp = String(page.headers['content-security-policy']);
    const directive = (name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
    expect(directive('script-src')).toBe("script-src 'self'");
    expect(directive('default-src')).toBe("default-src 'self'");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('base-uri')).toBe("base-uri 'none'");
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(page.headers['x-content-type-options']).toBe('nosniff');

    const info = await visit(l.token, 'info');
    expect(info.headers['content-type']).toMatch(/^application\/json/);
    expect(info.json()).toEqual({ name: evil, type: 'file', locked: true });
    const cookie = unlockCookie(await unlock(l.token, 'pw'));
    const dl = await visit(l.token, 'content', { cookie });
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="<img src=x onerror=alert\(1\)>.txt"/);
    expect(dl.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
  });

  it('HTML, SVG and XML are always attachments with nosniff, even when a preview is asked for', async () => {
    const dir = await folder({ 'page.html': '<script>alert(1)</script>', 'pic.svg': '<svg onload="alert(1)"/>', 'data.xml': '<x/>' });
    const l = await link(dir);
    for (const name of ['page.html', 'pic.svg', 'data.xml']) {
      const r = await visit(l.token, `content?path=${encodeURIComponent(`/${name}`)}&inline=1`);
      expect(r.statusCode, name).toBe(200);
      expect(r.headers['content-disposition'], name).toMatch(/^attachment;/);
      expect(r.headers['x-content-type-options'], name).toBe('nosniff');
      expect(r.headers['content-security-policy'], name).toBe("sandbox; default-src 'none'");
    }
  });

  it('a folder link never reaches above its folder', async () => {
    const dir = await folder({ 'in.txt': 'inside' });
    await ok(put(`${dir}-secret.txt`, 'secret'));
    const l = await link(dir);
    for (const p of ['/../' + `${dir.slice(1)}-secret.txt`, '../x', '/a/../../x']) {
      const r = await visit(l.token, `content?path=${encodeURIComponent(p)}`);
      expect(r.statusCode, p).toBeGreaterThanOrEqual(400);
      expect(r.body).not.toContain('secret');
    }
  });
});

describe('managing links', () => {
  it('the owner changes label, limit and expiry and revokes; nobody else sees or touches the link', async () => {
    const dir = await folder({ 'a.txt': 'alpha' });
    const l = await link(`${dir}/a.txt`, { label: 'old', maxDownloads: 0 });
    const patch = (payload: unknown, s: S = owner) => t.app.inject({ method: 'PATCH', url: `/api/v1/links/${l.id}`, headers: mutating(s),
      payload: payload as object });
    expect((await patch({ label: 'x' }, other)).json()).toEqual({ code: 'NOT_FOUND' });
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/links/${l.id}`, headers: mutating(other) })).statusCode).toBe(404);
    expect((await t.app.inject({ url: `/api/v1/links?source=home&path=${encodeURIComponent(`${dir}/a.txt`)}`,
      headers: { cookie: other.cookie } })).json()).toEqual({ items: [] });
    expect((await patch({ token: 'mine' })).json()).toEqual({ code: 'VALIDATION' });

    const changed = (await ok(patch({ label: 'new', maxDownloads: 3, expiresAt: '2099-05-01T00:00:00Z' }))).json();
    expect(changed).toMatchObject({ label: 'new', maxDownloads: 3, expiresAt: '2099-05-01T00:00:00.000Z', hasPassword: false });
    expect((await visit(l.token, 'content')).statusCode).toBe(200);
    expect((await ok(patch({ expiresAt: null, maxDownloads: null }))).json()).toMatchObject({ expiresAt: null, maxDownloads: null });

    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/links/${l.id}`, headers: mutating(owner) })).statusCode).toBe(204);
    expect((await visit(l.token, 'content')).json()).toEqual({ code: 'NOT_FOUND' });
    expect(await linksOn(`${dir}/a.txt`)).toEqual([]);
  });
});
