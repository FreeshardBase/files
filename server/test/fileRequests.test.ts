import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Entry, FileRequest, FileRequestInfo, ReceivedFileList } from '@files/shared';
import type { ConnectedBackend, StorageBackend, WriteOptions } from '../src/storage/backend.ts';
import { homeRoot } from '../src/paths.ts';
import { MAX_FILES_PER_REQUEST, MAX_FILES_PER_VISITOR } from '../src/storage/fileRequests.ts';
import { VISITOR_UPLOAD_TTL_MS } from '../src/storage/local.ts';
import { expireUploads } from '../src/storage/uploads.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// #217: file requests, upload-only public links at /r/<token>. `testuser` owns the requests; visitors have no session,
// only the request's own cookie. Regression tests for #94 (names leaving the target folder) and the #196/#197 pattern
// (limits under parallel requests).

type S = { cookie: string; csrf: string };
let t: TestApp; let owner: S; let other: S; let ownerId = ''; let root = '';
const ORIGIN = 'https://files.example.com';
const MAX = 1024 ** 2;
const mutating = (s: S) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN });

// `testuser`'s cloud connection `cloud`: records every write, and lists /Inbox as a folder.
const cloudWrites: { path: string; bytes: string; opts: WriteOptions }[] = [];
const nope = async (): Promise<never> => { throw new Error('not used by the request test'); };
const cloud: StorageBackend = {
  list: nope, read: nope, mkdir: nope, move: nope, copy: nope, delete: nope,
  stat: async (p) => ({ name: p.slice(p.lastIndexOf('/') + 1), path: p, type: p === '/Inbox' ? 'directory' : 'file', size: 0,
    modified: '2026-10-01T00:00:00.000Z' }),
  write: async (p, body, opts) => {
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(c as Buffer);
    cloudWrites.push({ path: p, bytes: Buffer.concat(chunks).toString(), opts });
    return { name: p.slice(p.lastIndexOf('/') + 1), path: p, type: 'file', size: opts.size ?? 0, modified: '2026-10-02T00:00:00.000Z' } satisfies Entry;
  },
  quota: async () => { await duringQuota?.(); return { used: 0, total: 1000 }; },
};
// Runs while a visitor's creation waits for the provider's free space (#304: a revocation in between).
let duringQuota: (() => Promise<unknown>) | undefined;
const connections = async (user: { id: string }): Promise<ConnectedBackend[]> => user.id === ownerId ? [{ id: 'cloud', backend: cloud }] : [];
const logLines: string[] = [];
const logStream = new Writable({ write(chunk, _enc, cb) { logLines.push(String(chunk)); cb(); } });

beforeAll(async () => {
  t = await startTestApp({ FILES_MAX_UPLOAD_BYTES: String(MAX), FILES_LOG_LEVEL: 'info' }, undefined, logStream, { connections });
  owner = await login(t, 'testuser'); other = await login(t, 'member');
  ownerId = (await t.app.inject({ url: '/api/v1/me', headers: { cookie: owner.cookie } })).json().id;
  root = homeRoot(t.config.dataDir, ownerId);
});
afterAll(() => t.close());

const ok = async <R extends { statusCode: number; body: string }>(r: Promise<R>) => {
  const x = await r; expect(x.statusCode, x.body).toBeLessThan(300); return x;
};
const op = (name: string, payload: unknown) => t.app.inject({
  method: 'POST', url: `/api/v1/sources/home/${name}`, headers: mutating(owner), payload: payload as object });
const put = (path: string, text: string) => t.app.inject({
  method: 'PUT', url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=fail`,
  headers: { ...mutating(owner), 'content-type': 'application/octet-stream' }, payload: Buffer.from(text) });
let n = 0;
async function folder(files: Record<string, string> = {}): Promise<string> {
  const dir = `/requests-${++n}`;
  await ok(op('mkdir', { path: dir }));
  for (const [name, text] of Object.entries(files)) await ok(put(`${dir}/${name}`, text));
  return dir;
}
const createRequest = (payload: Record<string, unknown>, s: S = owner) =>
  t.app.inject({ method: 'POST', url: '/api/v1/requests', headers: mutating(s), payload });
async function request(path: string, extra: Record<string, unknown> = {}): Promise<FileRequest> {
  const r = await createRequest({ source: 'home', path, ...extra });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}

// A visitor: no session, only the request's cookie (minted by `info`), from one address.
type Visitor = { cookie: string; ip: string };
const b64 = (s: string) => Buffer.from(s).toString('base64');
const meta = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `${k} ${b64(v)}`).join(',');
const cookieOf = (setCookie: string | string[] | undefined) => ([] as string[]).concat(setCookie ?? []).map((c) => c.split(';')[0]!).join('; ');
// Each visitor from its own address unless a test says otherwise, so the per-address creation limit (#401) never couples tests.
let addresses = 0;
const nextIp = () => `2001:db8:${(++addresses).toString(16)}::1`;
async function visitor(token: string, ip = nextIp()): Promise<Visitor> {
  const r = await t.app.inject({ url: `/r/${token}/info`, remoteAddress: ip });
  expect(r.statusCode, r.body).toBe(200);
  return { cookie: cookieOf(r.headers['set-cookie']), ip };
}
const info = async (token: string, v: Visitor): Promise<FileRequestInfo> => {
  const r = await t.app.inject({ url: `/r/${token}/info`, headers: { cookie: v.cookie }, remoteAddress: v.ip });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const tus = (v: Visitor) => ({ cookie: v.cookie, origin: ORIGIN, 'tus-resumable': '1.0.0' });
const create = (token: string, v: Visitor, name: string, length: number, extra: Record<string, string> = {}) => t.app.inject({
  method: 'POST', url: `/r/${token}/uploads`, remoteAddress: v.ip,
  headers: { ...tus(v), 'upload-length': String(length), 'upload-metadata': meta({ name, ...extra }) } });
const patch = (location: string, v: Visitor, body: string, offset = 0) => t.app.inject({
  method: 'PATCH', url: location, remoteAddress: v.ip, payload: Buffer.from(body),
  headers: { ...tus(v), 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' } });
/** Creates and sends one whole file; returns the PATCH answer. */
async function upload(token: string, v: Visitor, name: string, body: string, extra: Record<string, string> = {}) {
  const c = await create(token, v, name, Buffer.byteLength(body), extra);
  expect(c.statusCode, c.body).toBe(201);
  return patch(String(c.headers.location), v, body);
}
const unlock = (token: string, v: Visitor, password: string) => t.app.inject({ method: 'POST', url: `/r/${token}/unlock`,
  remoteAddress: v.ip, headers: { cookie: v.cookie, origin: ORIGIN }, payload: { password } });
const listOwn = async (): Promise<FileRequest[]> => (await ok(t.app.inject({ url: '/api/v1/requests', headers: { cookie: owner.cookie } }))).json().items;
const files = async (id: string): Promise<ReceivedFileList['items']> =>
  (await ok(t.app.inject({ url: `/api/v1/requests/${id}/files`, headers: { cookie: owner.cookie } }))).json().items;
const namesIn = (dir: string) => readdirSync(join(root, dir)).filter((x) => !x.startsWith('.')).sort();

describe('creating and managing a request', () => {
  it('the owner creates a request on a folder of their home; the token has 128 bits and the target must be a folder', async () => {
    const dir = await folder({ 'a.txt': 'a' });
    const r = await request(dir, { label: 'Tax papers', maxFiles: 5, maxBytes: 1000, askName: true });
    expect(r).toMatchObject({ label: 'Tax papers', source: 'home', path: dir, maxFiles: 5, maxBytes: 1000, askName: true,
      hasPassword: false, revoked: false, orphaned: false, files: 0, newFiles: 0 });
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await createRequest({ source: 'home', path: `${dir}/a.txt` })).json()).toEqual({ code: 'NOT_A_DIRECTORY' });
    expect((await createRequest({ source: 'home', path: '/missing' })).statusCode).toBe(404);
    expect((await createRequest({ source: 'home', path: dir, expiresAt: 'tomorrow' })).json()).toEqual({ code: 'INVALID_EXPIRY' });
    expect((await listOwn()).map((x) => x.id)).toContain(r.id);
  });

  it('another member neither sees, edits nor revokes the request', async () => {
    const r = await request(await folder());
    const theirs = (await ok(t.app.inject({ url: '/api/v1/requests', headers: { cookie: other.cookie } }))).json().items as FileRequest[];
    expect(theirs.map((x) => x.id)).not.toContain(r.id);
    expect((await t.app.inject({ method: 'PATCH', url: `/api/v1/requests/${r.id}`, headers: mutating(other), payload: { label: 'x' } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/requests/${r.id}`, headers: mutating(other) })).statusCode).toBe(404);
    expect((await t.app.inject({ url: `/api/v1/requests/${r.id}/files`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
  });

  it('the owner edits label, limits and password', async () => {
    const r = await request(await folder(), { maxFiles: 1 });
    const e = await ok(t.app.inject({ method: 'PATCH', url: `/api/v1/requests/${r.id}`, headers: mutating(owner),
      payload: { label: 'Renamed', maxFiles: null, password: 'pw' } }));
    expect(e.json()).toMatchObject({ label: 'Renamed', maxFiles: null, hasPassword: true });
  });

  it('a share received from someone else cannot be the target', async () => {
    expect((await createRequest({ source: 'share:abc', path: '/x' })).json()).toEqual({ code: 'FORBIDDEN' });
  });
});

describe('the visitor', () => {
  it('uploads two files that land in the folder; sees only their own uploads, never the folder', async () => {
    const dir = await folder({ 'secret.txt': 'owner only' });
    const r = await request(dir, { label: 'Holiday photos', askName: true });
    const v = await visitor(r.token);
    const first = await info(r.token, v);
    expect(first).toEqual({ label: 'Holiday photos', locked: false, askName: true, expiresAt: null, filesLeft: MAX_FILES_PER_VISITOR, bytesLeft: null, uploads: [] });
    expect(JSON.stringify(first)).not.toContain('secret');
    expect(JSON.stringify(first)).not.toContain(dir);
    expect((await upload(r.token, v, 'one.jpg', 'first', { uploader: 'Test User' })).statusCode).toBe(204);
    expect((await upload(r.token, v, 'two.jpg', 'second', { uploader: 'Test User' })).statusCode).toBe(204);
    expect(namesIn(dir)).toEqual(['one.jpg', 'secret.txt', 'two.jpg']);
    expect(readFileSync(join(root, dir, 'two.jpg'), 'utf8')).toBe('second');
    const mine = await info(r.token, v);
    expect(mine.uploads!.map((u) => [u.name, u.size, u.done])).toEqual([['one.jpg', 5, true], ['two.jpg', 6, true]]);
    // Another visitor (another session) sees none of them.
    expect((await info(r.token, await visitor(r.token, '198.51.100.8'))).uploads).toEqual([]);
  });

  it('cannot list, download or overwrite: only the request routes exist, and a taken name is kept beside', async () => {
    const dir = await folder({ 'report.txt': 'original' });
    const r = await request(dir);
    const v = await visitor(r.token);
    for (const rest of ['list', 'list?path=%2F', 'content?path=%2Freport.txt', 'uploads', 'files']) {
      const x = await t.app.inject({ url: `/r/${r.token}/${rest}`, headers: { cookie: v.cookie }, remoteAddress: v.ip });
      expect(x.statusCode, rest).toBe(404);
      expect(x.body).not.toContain('original');
    }
    // The request's token is not a public link's.
    expect((await t.app.inject({ url: `/s/${r.token}/list` })).statusCode).toBe(404);
    // A metadata `onCollision` or `path` is ignored: collisions are always keep-both, inside the target.
    expect((await upload(r.token, v, 'report.txt', 'visitor', { onCollision: 'replace', path: '/report.txt' })).statusCode).toBe(204);
    expect(readFileSync(join(root, dir, 'report.txt'), 'utf8')).toBe('original');
    expect(readFileSync(join(root, dir, 'report (1).txt'), 'utf8')).toBe('visitor');
    expect(existsSync(join(root, 'report.txt'))).toBe(false);
  });

  // #305: keep-both appends ` (1)` only when the name is taken, so showing the saved name would let a visitor probe the folder.
  it('sees the names they sent, never the keep-both name that reveals a file of the folder', async () => {
    const dir = await folder({ 'secret-contract.pdf': 'owner only' });
    const r = await request(dir);
    const v = await visitor(r.token);
    for (const name of ['secret-contract.pdf', 'not-there.pdf']) {
      const c = await create(r.token, v, name, 0);
      expect(c.statusCode, c.body).toBe(201);
      expect((await patch(String(c.headers.location), v, '')).statusCode).toBe(204);
    }
    expect(namesIn(dir)).toEqual(['not-there.pdf', 'secret-contract (1).pdf', 'secret-contract.pdf']);
    const mine = await info(r.token, v);
    expect(mine.uploads!.map((u) => [u.name, u.done])).toEqual([['secret-contract.pdf', true], ['not-there.pdf', true]]);
    expect(JSON.stringify(mine)).not.toContain('(1)');
    // The owner sees where each file was saved.
    expect((await files(r.id)).map((f) => f.name).sort()).toEqual(['not-there.pdf', 'secret-contract (1).pdf']);
  });

  it('a visitor\'s name loses U+FFFD like a control character, so the file appears in the owner\'s listing (#379)', async () => {
    const dir = await folder();
    const r = await request(dir, { askName: true });
    const v = await visitor(r.token);
    expect((await upload(r.token, v, 'invoice�.pdf', 'pdf', { uploader: 'Test� User' })).statusCode).toBe(204);
    expect(namesIn(dir)).toEqual(['invoice.pdf']);
    const listed = await ok(t.app.inject({ url: `/api/v1/sources/home/list?path=${encodeURIComponent(dir)}`, headers: { cookie: owner.cookie } }));
    expect((listed.json().entries as Entry[]).map((e) => e.name)).toEqual(['invoice.pdf']);
    expect((await files(r.id)).map((f) => [f.name, f.uploader])).toEqual([['invoice.pdf', 'Test User']]);
  });

  it('names are sanitised and never leave the target folder (#94); colliding names are all kept', async () => {
    const parent = await folder();
    await ok(op('mkdir', { path: `${parent}/inbox` }));
    const dir = `${parent}/inbox`;
    const r = await request(dir);
    const v = await visitor(r.token);
    const long = `${'x'.repeat(300)}.pdf`;
    const names = ['../escape.txt', '../../escape.txt', '/etc/passwd', 'a\u0000b.txt', long, '..', '.', '', '.files',
      'sub/dir/name.txt', '..\\..\\win.txt', 'same.txt', 'same.txt', 'same.txt', '.0123456789abcdef.upload', ' spaced. '];
    for (const name of names) expect((await upload(r.token, v, name, `<${name}>`)).statusCode, JSON.stringify(name)).toBe(204);
    // Nothing outside the target folder: the parent holds only the target, the home only the parent and the internal area.
    expect(readdirSync(join(root, parent))).toEqual(['inbox']);
    expect(readdirSync(root).filter((x) => x.startsWith('requests-') === false && x !== '.files')).toEqual([]);
    const placed = readdirSync(join(root, dir));
    expect(placed).toHaveLength(names.length);
    for (const p of placed) {
      expect(p).not.toMatch(/[/\\\0]/);
      expect(p.startsWith('.')).toBe(false);
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(255);
    }
    expect(placed).toEqual(expect.arrayContaining(['escape.txt', 'escape (1).txt', 'passwd', 'ab.txt', 'name.txt', 'win.txt',
      'same.txt', 'same (1).txt', 'same (2).txt', 'files', 'spaced']));
    expect(placed.find((p) => p.endsWith('.pdf'))).toMatch(/^x+\.pdf$/);
    // Every byte arrived under some name: nothing was overwritten.
    const contents = placed.map((p) => readFileSync(join(root, dir, p), 'utf8')).sort();
    expect(contents).toEqual(names.map((x) => `<${x}>`).sort());
  });

  it('a name taken by a folder is kept beside it, never refused', async () => {
    const dir = await folder();
    await ok(op('mkdir', { path: `${dir}/photos` }));
    const r = await request(dir);
    const v = await visitor(r.token);
    expect((await upload(r.token, v, 'photos', 'a file')).statusCode).toBe(204);
    expect(namesIn(dir)).toEqual(['photos', 'photos (1)']);
    expect(readFileSync(join(root, dir, 'photos (1)'), 'utf8')).toBe('a file');
  });

  it('size limits apply while streaming: more bytes than declared drop the upload and place nothing', async () => {
    const dir = await folder();
    const r = await request(dir);
    const v = await visitor(r.token);
    const c = await create(r.token, v, 'big.bin', 4);
    expect((await patch(String(c.headers.location), v, 'more than four')).json()).toEqual({ code: 'SIZE_MISMATCH' });
    expect(namesIn(dir)).toEqual([]);
    expect((await create(r.token, v, 'huge.bin', MAX + 1)).json()).toEqual({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('the owner\'s quota is checked before a byte is accepted', async () => {
    const dir = await folder();
    const r = await request(dir);
    const v = await visitor(r.token);
    t.db.prepare('UPDATE users SET quota_bytes = ? WHERE id = ?').run(1, ownerId);
    try {
      expect((await create(r.token, v, 'q.bin', 1_000_000)).json()).toEqual({ code: 'QUOTA_EXCEEDED' });
    } finally { t.db.prepare('UPDATE users SET quota_bytes = NULL WHERE id = ?').run(ownerId); }
  });

  it('another visitor cannot resume, read or finish someone else\'s upload', async () => {
    const r = await request(await folder());
    const a = await visitor(r.token); const b = await visitor(r.token, '198.51.100.9');
    const c = await create(r.token, a, 'mine.txt', 4);
    const loc = String(c.headers.location);
    expect((await t.app.inject({ method: 'HEAD', url: loc, headers: tus(b), remoteAddress: b.ip })).statusCode).toBe(404);
    expect((await patch(loc, b, 'evil')).statusCode).toBe(404);
    expect((await patch(loc, a, 'mine')).statusCode).toBe(204);
  });

  it('a mutating request from another origin is refused', async () => {
    const r = await request(await folder());
    const v = await visitor(r.token);
    const x = await t.app.inject({ method: 'POST', url: `/r/${r.token}/uploads`, remoteAddress: v.ip,
      headers: { cookie: v.cookie, origin: 'https://evil.example', 'tus-resumable': '1.0.0', 'upload-length': '1', 'upload-metadata': meta({ name: 'a' }) } });
    expect(x.json()).toEqual({ code: 'CSRF' });
  });
});

describe('limits under parallel uploads (#196/#197 pattern)', () => {
  it('maxFiles holds when ten uploads are created at once', async () => {
    const dir = await folder();
    const r = await request(dir, { maxFiles: 3 });
    const v = await visitor(r.token);
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => create(r.token, v, `f${i}.txt`, 1)));
    expect(res.filter((x) => x.statusCode === 201)).toHaveLength(3);
    expect(res.filter((x) => x.statusCode !== 201).map((x) => x.json().code)).toEqual(Array(7).fill('REQUEST_FILE_LIMIT'));
    expect((await info(r.token, v)).filesLeft).toBe(0);
  });

  it('maxBytes holds when ten uploads are created at once, and counts placed files', async () => {
    const dir = await folder();
    const r = await request(dir, { maxBytes: 100 });
    const v = await visitor(r.token);
    expect((await upload(r.token, v, 'first.bin', 'x'.repeat(10))).statusCode).toBe(204);
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => create(r.token, v, `p${i}.bin`, 30)));
    expect(res.filter((x) => x.statusCode === 201)).toHaveLength(3);
    expect(res.filter((x) => x.statusCode !== 201).map((x) => x.json().code)).toEqual(Array(7).fill('REQUEST_SIZE_LIMIT'));
    expect((await info(r.token, v)).bytesLeft).toBe(0);
  });
});

describe('expired, revoked and orphaned requests answer 410', () => {
  it('an expired request', async () => {
    const r = await request(await folder(), { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const v = await visitor(r.token);
    t.db.prepare('UPDATE file_requests SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', r.id);
    const x = await t.app.inject({ url: `/r/${r.token}/info`, remoteAddress: v.ip });
    expect([x.statusCode, x.json().code]).toEqual([410, 'LINK_EXPIRED']);
    expect((await create(r.token, v, 'late.txt', 1)).statusCode).toBe(410);
  });

  it('a revoked request, also for an upload in progress', async () => {
    const dir = await folder();
    const r = await request(dir);
    const v = await visitor(r.token);
    const c = await create(r.token, v, 'cut.txt', 4);
    await ok(t.app.inject({ method: 'DELETE', url: `/api/v1/requests/${r.id}`, headers: mutating(owner) }));
    const x = await t.app.inject({ url: `/r/${r.token}/info`, remoteAddress: v.ip });
    expect([x.statusCode, x.json().code]).toEqual([410, 'LINK_REVOKED']);
    expect((await patch(String(c.headers.location), v, 'cut!')).statusCode).toBe(410);
    expect(namesIn(dir)).toEqual([]);
    expect((await listOwn()).find((x) => x.id === r.id)).toMatchObject({ revoked: true });
  });

  it('an unknown token is 404; a deleted folder orphans the request; a moved folder takes it along', async () => {
    expect((await t.app.inject({ url: '/r/AAAAAAAAAAAAAAAAAAAAAA/info' })).statusCode).toBe(404);
    const dir = await folder();
    const r = await request(dir);
    await ok(op('move', { from: dir, to: `${dir}-moved`, onCollision: 'fail' }));
    expect((await listOwn()).find((x) => x.id === r.id)!.path).toBe(`${dir}-moved`);
    const v = await visitor(r.token);
    expect((await upload(r.token, v, 'after-move.txt', 'm')).statusCode).toBe(204);
    expect(namesIn(`${dir}-moved`)).toEqual(['after-move.txt']);
    await ok(op('delete', { paths: [`${dir}-moved`] }));
    const x = await t.app.inject({ url: `/r/${r.token}/info`, remoteAddress: v.ip });
    expect([x.statusCode, x.json().code]).toEqual([410, 'SHARE_ORPHANED']);
    expect((await listOwn()).find((x) => x.id === r.id)).toMatchObject({ orphaned: true });
  });
});

describe('password', () => {
  it('a locked request reveals only its label; uploads need the password; wrong guesses are rate limited', async () => {
    const r = await request(await folder(), { label: 'Locked', password: 'open sesame' });
    const v = await visitor(r.token, '203.0.113.5');
    expect(await info(r.token, v)).toEqual({ label: 'Locked', locked: true });
    expect((await create(r.token, v, 'a.txt', 1)).json()).toEqual({ code: 'PASSWORD_REQUIRED' });
    expect((await unlock(r.token, v, 'wrong')).json()).toEqual({ code: 'PASSWORD_WRONG' });
    const good = await unlock(r.token, v, 'open sesame');
    expect(good.statusCode).toBe(204);
    const unlocked = { ...v, cookie: cookieOf(good.headers['set-cookie']) };
    expect((await info(r.token, unlocked)).locked).toBe(false);
    expect((await upload(r.token, unlocked, 'a.txt', 'a')).statusCode).toBe(204);
    // The same limits as public links: 5 wrong guesses per request, then 429 even for the right password.
    const w = await visitor(r.token, '203.0.113.6');
    for (let i = 0; i < 4; i++) expect((await unlock(r.token, w, 'nope')).statusCode).toBe(403);
    expect((await unlock(r.token, w, 'open sesame')).statusCode).toBe(429);
  });
});

describe('the owner side', () => {
  it('counts new files with the uploader\'s name until the owner has seen them', async () => {
    const dir = await folder();
    const r = await request(dir, { askName: true });
    const v = await visitor(r.token);
    await ok(upload(r.token, v, 'one.txt', '1', { uploader: '  Test User  ' }));
    await ok(upload(r.token, v, 'two.txt', '22'));
    expect((await listOwn()).find((x) => x.id === r.id)).toMatchObject({ files: 2, bytes: 3, newFiles: 2 });
    expect((await files(r.id)).map((f) => [f.name, f.size, f.uploader, f.new])).toEqual([['two.txt', 2, null, true], ['one.txt', 1, 'Test User', true]]);
    await ok(t.app.inject({ method: 'POST', url: `/api/v1/requests/${r.id}/seen`, headers: mutating(owner) }));
    expect((await listOwn()).find((x) => x.id === r.id)).toMatchObject({ files: 2, newFiles: 0 });
    expect((await files(r.id)).every((f) => !f.new)).toBe(true);
  });

  it('the uploader name is not kept when the request does not ask for it', async () => {
    const r = await request(await folder(), { askName: false });
    const v = await visitor(r.token);
    await ok(upload(r.token, v, 'x.txt', 'x', { uploader: 'Test User' }));
    expect((await files(r.id))[0]!.uploader).toBeNull();
  });
});

describe('a cloud folder as the target', () => {
  it('the upload is written into the cloud folder with keep-both; the provider\'s free space is checked first', async () => {
    const r = await request('/Inbox', { source: 'conn:cloud' });
    const v = await visitor(r.token);
    expect((await upload(r.token, v, '../up.txt', 'to the cloud')).statusCode).toBe(204);
    expect(cloudWrites).toEqual([{ path: '/Inbox/up.txt', bytes: 'to the cloud', opts: expect.objectContaining({ onCollision: 'keep-both', size: 12 }) }]);
    expect((await create(r.token, v, 'too-big.bin', 1001)).json()).toEqual({ code: 'QUOTA_EXCEEDED' });
    // Nothing is left staged in the owner's home.
    expect(t.db.prepare('SELECT COUNT(*) FROM uploads WHERE user_id = ? AND source = ?').pluck().get(ownerId, 'conn:cloud')).toBe(0);
    // The staged upload goes, the received file stays and counts against the caps (#401).
    const seen = await info(r.token, v);
    expect([seen.filesLeft, seen.uploads?.map((u) => [u.name, u.done])]).toEqual([MAX_FILES_PER_VISITOR - 1, [['up.txt', true]]]);
    expect((await files(r.id)).map((f) => f.name)).toEqual(['up.txt']);
  });
});

it('the token never reaches the log', async () => {
  const r = await request(await folder());
  await visitor(r.token);
  expect(logLines.join('\n')).not.toContain(r.token);
  expect(logLines.join('\n')).toContain('/r/<token>');
});

it('the visitor\'s session sees nothing of another request', async () => {
  const a = await request(await folder()); const b = await request(await folder());
  const v = await visitor(a.token);
  await ok(upload(a.token, v, 'x.txt', 'x'));
  const x = await t.app.inject({ url: `/r/${b.token}/info`, headers: { cookie: v.cookie } });
  expect(x.json().uploads).toEqual([]);
});

// #304: a visitor's unfinished uploads hold the owner's quota; revoking, expiring or orphaning a request, or the owner's
// discard, releases them, and a request caps how many may be open at once.
describe('a visitor\'s unfinished uploads (#304)', () => {
  const ownerCreate = (path: string, length: number) => t.app.inject({ method: 'POST', url: '/api/v1/uploads',
    headers: { ...mutating(owner), 'tus-resumable': '1.0.0', 'upload-length': String(length), 'upload-metadata': meta({ source: 'home', path }) } });
  const uploadRows = (ids: string[]) => ids.filter((id) => t.db.prepare('SELECT 1 FROM uploads WHERE id = ? AND user_id = ?').get(id, ownerId) !== undefined);
  const staged = (ids: string[]) => ids.filter((id) => existsSync(join(root, '.files', 'uploads', id)));
  const requestRows = (id: string) => t.db.prepare('SELECT COUNT(*) FROM file_request_uploads WHERE request_id = ? AND placed_at IS NULL').pluck().get(id);
  const idOf = (location: unknown) =>String(location).split('/').pop()!;
  const pendingOf = async (id: string) => (await listOwn()).find((x) => x.id === id)!.pending;

  it('revoking the request terminates them at once: the owner\'s quota is free again', async () => {
    const dir = await folder();
    const r = await request(dir);
    const v = await visitor(r.token);
    t.db.prepare('UPDATE users SET quota_bytes = ? WHERE id = ?').run(1_000_000, ownerId);
    try {
      const c = await create(r.token, v, 'hold.bin', 900_000);
      expect(c.statusCode, c.body).toBe(201);
      const held = idOf(c.headers.location);
      expect(await pendingOf(r.id)).toBe(1);
      expect((await ownerCreate(`${dir}/mine.bin`, 200_000)).json()).toEqual({ code: 'QUOTA_EXCEEDED' });
      await ok(t.app.inject({ method: 'DELETE', url: `/api/v1/requests/${r.id}`, headers: mutating(owner) }));
      expect(uploadRows([held])).toEqual([]);
      expect(staged([held])).toEqual([]);
      expect(requestRows(r.id)).toBe(0);
      expect(await pendingOf(r.id)).toBe(0);
      const mine = await ownerCreate(`${dir}/mine.bin`, 200_000);
      expect(mine.statusCode, mine.body).toBe(201);
      await ok(t.app.inject({ method: 'DELETE', url: String(mine.headers.location), headers: { ...mutating(owner), 'tus-resumable': '1.0.0' } }));
    } finally { t.db.prepare('UPDATE users SET quota_bytes = NULL WHERE id = ?').run(ownerId); }
  });

  it('a visitor may hold 10 open uploads at once; the 11th is REQUEST_UPLOADS_OPEN, a finished one frees its place', async () => {
    const r = await request(await folder());
    const v = await visitor(r.token);
    const res = await Promise.all(Array.from({ length: 11 }, (_, i) => create(r.token, v, `o${i}.bin`, 1)));
    expect(res.filter((x) => x.statusCode === 201)).toHaveLength(10);
    expect(res.filter((x) => x.statusCode !== 201).map((x) => [x.statusCode, x.json().code])).toEqual([[409, 'REQUEST_UPLOADS_OPEN']]);
    expect(t.db.prepare('SELECT COUNT(*) FROM file_request_uploads WHERE request_id = ?').pluck().get(r.id)).toBe(10);
    // Finishing one makes room for one more.
    expect((await patch(String(res.find((x) => x.statusCode === 201)!.headers.location), v, 'x')).statusCode).toBe(204);
    expect((await create(r.token, v, 'next.bin', 1)).statusCode).toBe(201);
    expect((await create(r.token, v, 'over.bin', 1)).json()).toEqual({ code: 'REQUEST_UPLOADS_OPEN' });
  });

  it('a request holds at most 100 open uploads, whatever the number of visitors', async () => {
    const r = await request(await folder());
    const visitors = await Promise.all(Array.from({ length: 11 }, () => visitor(r.token)));
    const res = await Promise.all(visitors.flatMap((v, i) => Array.from({ length: 10 }, (_, j) => create(r.token, v, `v${i}-${j}.bin`, 1))));
    expect(res.filter((x) => x.statusCode === 201)).toHaveLength(100);
    expect(res.filter((x) => x.statusCode !== 201).map((x) => x.json().code)).toEqual(Array(10).fill('REQUEST_UPLOADS_OPEN'));
    expect(await pendingOf(r.id)).toBe(100);
    await ok(t.app.inject({ method: 'DELETE', url: `/api/v1/requests/${r.id}`, headers: mutating(owner) }));
  });

  it('the owner discards them without closing the request', async () => {
    const dir = await folder();
    const r = await request(dir);
    const v = await visitor(r.token);
    const c = await create(r.token, v, 'half.txt', 4);
    expect((await patch(String(c.headers.location), v, 'ha')).statusCode).toBe(204);
    const id = idOf(c.headers.location);
    expect(await pendingOf(r.id)).toBe(1);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/requests/${r.id}/uploads`, headers: mutating(other) })).statusCode).toBe(404);
    expect(uploadRows([id])).toEqual([id]);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/requests/${r.id}/uploads`, headers: mutating(owner) })).statusCode).toBe(204);
    expect(uploadRows([id])).toEqual([]);
    expect(staged([id])).toEqual([]);
    expect(requestRows(r.id)).toBe(0);
    expect(await pendingOf(r.id)).toBe(0);
    expect((await patch(String(c.headers.location), v, 'lf', 2)).statusCode).toBe(404);
    expect((await info(r.token, v)).uploads).toEqual([]);
    // The request still takes files.
    expect((await upload(r.token, v, 'whole.txt', 'whole')).statusCode).toBe(204);
    expect(namesIn(dir)).toEqual(['whole.txt']);
  });

  it('a creation revoked before its reservation is refused before any upload opens', async () => {
    const r = await request('/Inbox', { source: 'conn:cloud' });
    const v = await visitor(r.token);
    duringQuota = () => ok(t.app.inject({ method: 'DELETE', url: `/api/v1/requests/${r.id}`, headers: mutating(owner) }));
    // A home with no room left: an upload that opened would answer QUOTA_EXCEEDED, not the revocation.
    t.db.prepare('UPDATE users SET quota_bytes = ? WHERE id = ?').run(1, ownerId);
    try {
      const c = await create(r.token, v, 'late.bin', 10);
      expect([c.statusCode, c.json().code]).toEqual([410, 'LINK_REVOKED']);
    } finally { duringQuota = undefined; t.db.prepare('UPDATE users SET quota_bytes = NULL WHERE id = ?').run(ownerId); }
    expect(t.db.prepare('SELECT COUNT(*) FROM file_request_uploads WHERE request_id = ?').pluck().get(r.id)).toBe(0);
    expect(t.db.prepare('SELECT COUNT(*) FROM uploads WHERE user_id = ? AND source = ?').pluck().get(ownerId, 'conn:cloud')).toBe(0);
  });

  it('a creation revoked between its reservation and its upload terminates the upload itself', async () => {
    const r = await request(await folder());
    const v = await visitor(r.token);
    const before = new Set(readdirSync(join(root, '.files', 'uploads')));
    // The revocation lands right when the upload is attached to its reservation, after the revocation's discard
    // could have seen it.
    const prepare = t.db.prepare.bind(t.db);
    const spy = vi.spyOn(t.db, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('UPDATE file_request_uploads SET upload_id')) {
        prepare('UPDATE file_requests SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), r.id);
      }
      return prepare(sql);
    });
    try {
      const c = await create(r.token, v, 'late.bin', 10);
      expect([c.statusCode, c.json().code]).toEqual([410, 'LINK_REVOKED']);
    } finally { spy.mockRestore(); }
    expect(t.db.prepare('SELECT COUNT(*) FROM file_request_uploads WHERE request_id = ?').pluck().get(r.id)).toBe(0);
    expect(readdirSync(join(root, '.files', 'uploads')).filter((x) => !before.has(x))).toEqual([]);
  });

  it('reservations whose upload is still opening count as open', async () => {
    const r = await request(await folder());
    const insert = t.db.prepare(`INSERT INTO file_request_uploads (id, request_id, visitor, upload_id, name, length, uploader, created_at)
      VALUES (?, ?, ?, NULL, 'x', 1, NULL, ?)`);
    for (let i = 0; i < 100; i++) insert.run(randomBytes(16).toString('hex'), r.id, randomBytes(16).toString('hex'), new Date().toISOString());
    try {
      expect((await create(r.token, await visitor(r.token), 'more.bin', 1)).json()).toEqual({ code: 'REQUEST_UPLOADS_OPEN' });
    } finally { t.db.prepare('DELETE FROM file_request_uploads WHERE request_id = ?').run(r.id); }
  });

  it('the upload expiry job terminates them for an expired, orphaned or revoked request', async () => {
    const expiring = await request(await folder(), { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const orphanDir = await folder();
    const orphaning = await request(orphanDir);
    const revoking = await request(await folder());
    const live = await request(await folder());
    const ids: string[] = [];
    for (const r of [expiring, orphaning, revoking, live]) {
      const c = await create(r.token, await visitor(r.token), 'wait.bin', 10);
      expect(c.statusCode, c.body).toBe(201);
      ids.push(idOf(c.headers.location));
    }
    t.db.prepare('UPDATE file_requests SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', expiring.id);
    await ok(op('delete', { paths: [orphanDir] }));
    expect((await listOwn()).find((x) => x.id === orphaning.id)).toMatchObject({ orphaned: true });
    // Revoked while its upload was receiving bytes: the revocation's discard left it (busy), the job takes it.
    t.db.prepare('UPDATE file_requests SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), revoking.id);
    const result = await expireUploads(t.app.deps, pino({ level: 'silent' }));
    expect(result.removed).toEqual(expect.arrayContaining([ids[0], ids[1], ids[2]]));
    expect(uploadRows(ids)).toEqual([ids[3]]);
    expect(staged(ids)).toEqual([ids[3]]);
    expect(await pendingOf(live.id)).toBe(1);
  });
});

describe('files placed through a request are bounded even without a file limit (#401)', () => {
  // Zero-byte files: no quota or disk reserve stops them, so only the file caps and the creation rate do.
  const empty = async (token: string, v: Visitor, name: string) => {
    const c = await create(token, v, name, 0);
    return c.statusCode === 201 ? patch(String(c.headers.location), v, '') : c;
  };
  // Moves the clock past the creation rate's window, so loops of more than 60 creations measure the caps only.
  const later = () => vi.setSystemTime(Date.now() + 61_000);
  const placeAll = async (token: string, v: Visitor, prefix: string, count: number) => {
    const codes: number[] = [];
    for (let i = 0; i < count; i++) {
      if (i % 50 === 0) later();
      codes.push((await empty(token, v, `${prefix}-${i}.txt`)).statusCode);
    }
    return codes;
  };

  it('one visitor places at most MAX_FILES_PER_VISITOR files; other visitors go on until MAX_FILES_PER_REQUEST', async () => {
    expect([MAX_FILES_PER_VISITOR, MAX_FILES_PER_REQUEST]).toEqual([100, 1000]);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      const dir = await folder();
      const r = await request(dir);
      expect(r.maxFiles).toBeNull();
      const v = await visitor(r.token);
      expect((await info(r.token, v)).filesLeft).toBe(MAX_FILES_PER_VISITOR);
      expect(await placeAll(r.token, v, 'v0', MAX_FILES_PER_VISITOR)).toEqual(Array(MAX_FILES_PER_VISITOR).fill(204));
      const over = await create(r.token, v, 'over.txt', 0);
      expect([over.statusCode, over.json()]).toEqual([409, { code: 'REQUEST_FILE_LIMIT' }]);
      expect(namesIn(dir)).toHaveLength(MAX_FILES_PER_VISITOR);
      expect((await info(r.token, v)).filesLeft).toBe(0);

      // More visitors fill the request up to its ceiling; then nobody places another file.
      for (let k = 1; k < MAX_FILES_PER_REQUEST / MAX_FILES_PER_VISITOR; k++) {
        expect(await placeAll(r.token, await visitor(r.token), `v${k}`, MAX_FILES_PER_VISITOR)).toEqual(Array(MAX_FILES_PER_VISITOR).fill(204));
      }
      const last = await visitor(r.token);
      expect((await info(r.token, last)).filesLeft).toBe(0);
      const full = await create(r.token, last, 'full.txt', 0);
      expect([full.statusCode, full.json()]).toEqual([409, { code: 'REQUEST_FILE_LIMIT' }]);
      expect(namesIn(dir)).toHaveLength(MAX_FILES_PER_REQUEST);
      expect(t.db.prepare('SELECT COUNT(*) FROM file_request_uploads WHERE request_id = ?').pluck().get(r.id)).toBe(MAX_FILES_PER_REQUEST);
    } finally { vi.useRealTimers(); }
  }, 120_000);

  it('a visitor\'s open uploads count against their cap with the placed ones', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      const r = await request(await folder());
      const v = await visitor(r.token);
      const placed = MAX_FILES_PER_VISITOR - 5;
      expect(await placeAll(r.token, v, 'p', placed)).toEqual(Array(placed).fill(204));
      for (let i = 0; i < 5; i++) expect((await create(r.token, v, `open-${i}.bin`, 1)).statusCode).toBe(201);
      expect((await info(r.token, v)).filesLeft).toBe(0);
      expect((await create(r.token, v, 'over.bin', 1)).json()).toEqual({ code: 'REQUEST_FILE_LIMIT' });
    } finally { vi.useRealTimers(); }
  });

  it('refused creations count against the rate too', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      const r = await request(await folder(), { maxFiles: 1 });
      const v = await visitor(r.token);
      expect((await empty(r.token, v, 'only.txt')).statusCode).toBe(204);
      for (let i = 0; i < 59; i++) expect((await create(r.token, v, `no-${i}.txt`, 0)).json()).toEqual({ code: 'REQUEST_FILE_LIMIT' });
      expect((await create(r.token, v, 'no-more.txt', 0)).statusCode).toBe(429);
    } finally { vi.useRealTimers(); }
  });

  it('an upload the visitor overruns leaves no row behind, so dropped uploads cannot grow the table without bound', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      const r = await request(await folder());
      const v = await visitor(r.token);
      const rows = () => t.db.prepare('SELECT COUNT(*) FROM file_request_uploads WHERE request_id = ?').pluck().get(r.id);
      const idOf = (location: unknown) => String(location).split('/').pop()!;
      for (let i = 0; i < 3; i++) {
        const c = await create(r.token, v, `${'n'.repeat(240)}-${i}.bin`, 1, { uploader: 'u'.repeat(100) });
        expect(c.statusCode, c.body).toBe(201);
        const over = await patch(String(c.headers.location), v, 'xx');
        expect([over.statusCode, over.json()]).toEqual([400, { code: 'SIZE_MISMATCH' }]);
        expect(rows()).toBe(0);
      }
      // An open upload the expiry job drops goes the same way.
      const c = await create(r.token, v, 'stale.bin', 1);
      expect(c.statusCode, c.body).toBe(201);
      expect(rows()).toBe(1);
      const expired = await expireUploads(t.app.deps, pino({ level: 'silent' }), new Date(Date.now() + VISITOR_UPLOAD_TTL_MS + 1));
      expect(expired.removed).toContain(idOf(c.headers.location));
      expect(rows()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('the owner\'s file limit may not exceed the ceiling; a lower one still applies', async () => {
    expect((await createRequest({ source: 'home', path: await folder(), maxFiles: MAX_FILES_PER_REQUEST + 1 })).statusCode).toBe(400);
    const atCeiling = await request(await folder(), { maxFiles: MAX_FILES_PER_REQUEST });
    expect(atCeiling.maxFiles).toBe(MAX_FILES_PER_REQUEST);
    expect((await t.app.inject({ method: 'PATCH', url: `/api/v1/requests/${atCeiling.id}`, headers: mutating(owner),
      payload: { maxFiles: 100_000 } })).statusCode).toBe(400);
    const r = await request(await folder(), { maxFiles: 3 });
    expect((await info(r.token, await visitor(r.token))).filesLeft).toBe(3);
  });

  it('a visitor creates at most 60 uploads a minute, from any address; the 61st is 429 with retry-after', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      const r = await request(await folder());
      const v = await visitor(r.token);
      // A new address for each: the limit follows the visitor's session, not only its address.
      for (let i = 0; i < 60; i++) expect((await empty(r.token, { ...v, ip: nextIp() }, `r${i}.txt`)).statusCode).toBe(204);
      const refused = await create(r.token, { ...v, ip: nextIp() }, 'r60.txt', 0);
      expect([refused.statusCode, refused.json()]).toEqual([429, { code: 'TOO_MANY_ATTEMPTS' }]);
      expect(Number(refused.headers['retry-after'])).toBe(60);
      // Only this visitor waits: another sender of the same request goes on.
      expect((await empty(r.token, await visitor(r.token), 'someone-else.txt')).statusCode).toBe(204);
      later();
      expect((await empty(r.token, v, 'r61.txt')).statusCode).toBe(204);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ['an IPv4 address', () => '198.51.100.20'],
    ['an IPv6 /64, any address in it', (i: number) => `2001:db8:ffff:1:${i.toString(16)}::1`],
    ['an IPv4-mapped address as its IPv4', (i: number) => (i % 2 === 0 ? '::ffff:198.51.100.21' : '198.51.100.21')],
  ])('%s creates at most 60 uploads a minute, whatever the visitor sessions and requests', async (_, ipFor) => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      const a = await request(await folder()); const b = await request(await folder());
      // A new session for each, on two requests: neither dropping the cookie nor another request resets the count.
      for (let i = 0; i < 60; i++) {
        const r = i % 2 === 0 ? a : b;
        expect((await empty(r.token, await visitor(r.token, ipFor(i)), `a${i}.txt`)).statusCode).toBe(204);
      }
      const refused = await create(a.token, await visitor(a.token, ipFor(60)), 'a60.txt', 0);
      expect([refused.statusCode, refused.json()]).toEqual([429, { code: 'TOO_MANY_ATTEMPTS' }]);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect((await empty(a.token, await visitor(a.token), 'other.txt')).statusCode).toBe(204);
    } finally { vi.useRealTimers(); }
  });
});
