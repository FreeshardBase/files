import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pino from 'pino';
import { homeRoot } from '../src/paths.ts';
import { expireUploads } from '../src/storage/uploads.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// #140 (absorbs #43, #113): resumable uploads over tus 1.0. Bytes go over a real socket where the test needs an
// interrupted or chunked body; everything else goes through inject.

let t: TestApp; let a: { cookie: string; csrf: string }; let b: { cookie: string; csrf: string };
let userId: string; let root: string; let port: number;
const ORIGIN = 'https://files.example.com';
const MAX = 5 * 1024 ** 3;
beforeAll(async () => {
  t = await startTestApp({ FILES_MAX_UPLOAD_BYTES: String(MAX) });
  a = await login(t, 'testuser');
  b = await login(t, 'member');
  userId = (await t.app.inject({ url: '/api/v1/me', headers: { cookie: a.cookie } })).json().id;
  root = homeRoot(t.config.dataDir, userId);
  mkdirSync(root, { recursive: true });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  port = (t.app.server.address() as AddressInfo).port;
});
afterAll(() => t.close());

type S = { cookie: string; csrf: string };
const b64 = (s: string) => Buffer.from(s).toString('base64');
const meta = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `${k} ${b64(v)}`).join(',');
const auth = (s: S) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN, 'tus-resumable': '1.0.0' });
const create = (path: string, length: number, s: S = a, extra: Record<string, string> = {}) => t.app.inject({
  method: 'POST', url: '/api/v1/uploads',
  headers: { ...auth(s), 'upload-length': String(length), 'upload-metadata': meta({ source: 'home', path, ...extra }) },
});
const idOf = (location: string | string[] | number | undefined) => String(location).split('/').pop()!;
const head = (id: string, s: S = a) => t.app.inject({ method: 'HEAD', url: `/api/v1/uploads/${id}`, headers: auth(s) });
const patch = (id: string, offset: number, body: Buffer, s: S = a) => t.app.inject({
  method: 'PATCH', url: `/api/v1/uploads/${id}`,
  headers: { ...auth(s), 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' }, payload: body,
});
const download = async (path: string) => (await t.app.inject({
  url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}`, headers: { cookie: a.cookie } })).rawPayload;
const uploadsDir = () => join(root, '.files', 'uploads');
const staged = () => (existsSync(uploadsDir()) ? readdirSync(uploadsDir()) : []);
const rows = (id: string) => t.db.prepare('SELECT * FROM uploads WHERE id = ?').all(id);
let n = 0;
const fresh = (stem: string) => `/${stem}-${++n}`;

/** A PATCH over a real socket; `abortAfter` destroys the socket once that many body bytes were written. */
function rawPatch(id: string, offset: number, body: Readable, headers: Record<string, string>, abortAfter?: number):
  Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string } | 'aborted'> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'PATCH', path: `/api/v1/uploads/${id}`,
      headers: { ...auth(a), 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (c: string) => { text += c; }).on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on('error', (e) => (abortAfter !== undefined ? resolve('aborted') : reject(e)));
    let sent = 0;
    body.on('data', (chunk: Buffer) => {
      if (abortAfter !== undefined && sent + chunk.length > abortAfter) {
        body.pause();
        req.write(chunk.subarray(0, abortAfter - sent), () => setTimeout(() => req.destroy(), 300));
        sent = abortAfter;
        return;
      }
      sent += chunk.length;
      if (!req.write(chunk)) { body.pause(); req.once('drain', () => body.resume()); }
    });
    body.on('end', () => { if (abortAfter === undefined) req.end(); });
  });
}

describe('tus protocol', () => {
  it('announces version, extensions and the size limit', async () => {
    const r = await t.app.inject({ method: 'OPTIONS', url: '/api/v1/uploads', headers: { cookie: a.cookie } });
    expect(r.statusCode).toBe(204);
    expect(r.headers['tus-version']).toBe('1.0.0');
    expect(String(r.headers['tus-extension']).split(',')).toEqual(expect.arrayContaining(['creation', 'termination', 'expiration']));
    expect(r.headers['tus-max-size']).toBe(String(MAX));
  });

  it('creates, reports the offset with HEAD, takes the bytes in two PATCHes and places the file', async () => {
    const path = `${fresh('two')}/Prüfung #1 50%.bin`;
    const data = randomBytes(10_000);
    const c = await create(path, data.length);
    expect(c.statusCode).toBe(201);
    expect(c.headers.location).toMatch(/^\/api\/v1\/uploads\/[0-9a-f]{32}$/);
    expect(c.headers['tus-resumable']).toBe('1.0.0');
    expect(Date.parse(String(c.headers['upload-expires']))).toBeGreaterThan(Date.now());
    const id = idOf(c.headers.location);
    let h = await head(id);
    expect(h.statusCode).toBe(200);
    expect(h.headers['upload-offset']).toBe('0');
    expect(h.headers['upload-length']).toBe(String(data.length));
    expect(h.headers['cache-control']).toBe('no-store');
    const p1 = await patch(id, 0, data.subarray(0, 4000));
    expect(p1.statusCode).toBe(204);
    expect(p1.headers['upload-offset']).toBe('4000');
    h = await head(id);
    expect(h.headers['upload-offset']).toBe('4000');
    // A wrong offset is refused and changes nothing.
    const wrong = await patch(id, 3000, data.subarray(3000));
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().code).toBe('OFFSET_MISMATCH');
    expect((await head(id)).headers['upload-offset']).toBe('4000');
    const p2 = await patch(id, 4000, data.subarray(4000));
    expect(p2.statusCode).toBe(204);
    expect(p2.headers['upload-offset']).toBe(String(data.length));
    expect(Buffer.compare(await download(path), data)).toBe(0);
    // A completed upload is gone; nothing stays in the staging area.
    expect((await head(id)).statusCode).toBe(404);
    expect(staged()).not.toContain(id);
    expect(rows(id)).toEqual([]);
  });

  it('an upload interrupted after half the bytes resumes with HEAD + PATCH and matches byte for byte', async () => {
    const path = `${fresh('resume')}/big.bin`;
    const data = randomBytes(8 * 1024 * 1024);
    const half = data.length / 2;
    const id = idOf((await create(path, data.length)).headers.location);
    const cut = await rawPatch(id, 0, Readable.from([data.subarray(0, 1 << 20), data.subarray(1 << 20)]),
      { 'content-length': String(data.length) }, half);
    expect(cut).toBe('aborted');
    // The server records what arrived once it notices the drop; HEAD then reports it.
    let offset = 0;
    for (let i = 0; i < 100; i++) {
      const h = await head(id);
      offset = Number(h.headers['upload-offset']);
      const probe = await patch(id, offset, Buffer.alloc(0));
      if (offset > 0 && probe.statusCode === 204) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThanOrEqual(half);
    expect(existsSync(join(root, path))).toBe(false);
    const rest = await rawPatch(id, offset, Readable.from([data.subarray(offset)]), { 'content-length': String(data.length - offset) });
    expect(rest).toMatchObject({ status: 204, headers: { 'upload-offset': String(data.length) } });
    const got = readFileSync(join(root, path));
    expect(got.length).toBe(data.length);
    expect(Buffer.compare(got, data)).toBe(0);
  });

  it('requires Tus-Resumable and the offset content type', async () => {
    const id = idOf((await create(`${fresh('hdr')}/a.bin`, 10)).headers.location);
    const noVersion = await t.app.inject({ method: 'HEAD', url: `/api/v1/uploads/${id}`, headers: { cookie: a.cookie } });
    expect(noVersion.statusCode).toBe(412);
    expect(noVersion.headers['tus-version']).toBe('1.0.0');
    const json = await t.app.inject({ method: 'PATCH', url: `/api/v1/uploads/${id}`,
      headers: { ...auth(a), 'upload-offset': '0', 'content-type': 'application/json' }, payload: '{"a":1}' });
    expect(json.statusCode).toBe(415);
    expect((await head(id)).headers['upload-offset']).toBe('0');
  });

  it('termination removes the row and the staged bytes', async () => {
    const id = idOf((await create(`${fresh('term')}/a.bin`, 100)).headers.location);
    await patch(id, 0, Buffer.alloc(50, 1));
    expect(staged()).toContain(id);
    const d = await t.app.inject({ method: 'DELETE', url: `/api/v1/uploads/${id}`, headers: auth(a) });
    expect(d.statusCode).toBe(204);
    expect((await head(id)).statusCode).toBe(404);
    expect(staged()).not.toContain(id);
    expect(rows(id)).toEqual([]);
  });
});

describe('collisions at creation and at finalisation', () => {
  it('fail answers FILE_EXISTS at creation, before any byte; keep-both places "name (1)"', async () => {
    const d = fresh('coll');
    mkdirSync(join(root, d));
    writeFileSync(join(root, d, 'a.txt'), 'old');
    const c = await create(`${d}/a.txt`, 3);
    expect(c.statusCode).toBe(409);
    expect(c.json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'a.txt' } });
    const id = idOf((await create(`${d}/a.txt`, 3, a, { onCollision: 'keep-both' })).headers.location);
    expect((await patch(id, 0, Buffer.from('new'))).statusCode).toBe(204);
    expect((await download(`${d}/a.txt`)).toString()).toBe('old');
    expect((await download(`${d}/a (1).txt`)).toString()).toBe('new');
  });

  it('a name taken during the upload keeps the bytes; finish places them with the chosen policy', async () => {
    const d = fresh('late');
    const id = idOf((await create(`${d}/a.txt`, 3)).headers.location);
    mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, d, 'a.txt'), 'old');
    const last = await patch(id, 0, Buffer.from('new'));
    expect(last.statusCode).toBe(409);
    expect(last.json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'a.txt' } });
    expect((await head(id)).headers['upload-offset']).toBe('3');
    expect((await download(`${d}/a.txt`)).toString()).toBe('old');
    const fin = await t.app.inject({ method: 'POST', url: `/api/v1/uploads/${id}/finish`, headers: auth(a), payload: { onCollision: 'replace' } });
    expect(fin.statusCode).toBe(201);
    expect(fin.json()).toMatchObject({ path: `${d}/a.txt`, size: 3 });
    expect((await download(`${d}/a.txt`)).toString()).toBe('new');
    expect((await head(id)).statusCode).toBe(404);
  });

  it('finish refuses an upload that is not complete', async () => {
    const id = idOf((await create(`${fresh('early')}/a.txt`, 3)).headers.location);
    const fin = await t.app.inject({ method: 'POST', url: `/api/v1/uploads/${id}/finish`, headers: auth(a), payload: { onCollision: 'replace' } });
    expect(fin.statusCode).toBe(400);
    expect(fin.json().code).toBe('SIZE_MISMATCH');
  });

  it('creates missing parent folders, so a folder upload recreates its structure', async () => {
    const d = fresh('tree');
    for (const rel of ['Fotos/2026/x.txt', 'Fotos/y.txt']) {
      const id = idOf((await create(`${d}/${rel}`, 1)).headers.location);
      expect((await patch(id, 0, Buffer.from('z'))).statusCode).toBe(204);
    }
    expect(readdirSync(join(root, d, 'Fotos')).sort()).toEqual(['2026', 'y.txt']);
    expect(readdirSync(join(root, d, 'Fotos', '2026'))).toEqual(['x.txt']);
  });

  it('refuses the internal area, traversal and a folder as target', async () => {
    mkdirSync(join(root, 'isdir'), { recursive: true });
    for (const [path, code] of [['/.files/uploads/x', 'PATH_INVALID'], ['/a/../../x', 'PATH_INVALID'], ['/isdir', 'IS_A_DIRECTORY']]) {
      const r = await create(path!, 1);
      expect(r.json().code, path).toBe(code);
    }
    const other = await t.app.inject({ method: 'POST', url: '/api/v1/uploads',
      headers: { ...auth(a), 'upload-length': '1', 'upload-metadata': meta({ source: 'home:x', path: '/a' }) } });
    expect(other.statusCode).toBe(404);
    expect(other.json().code).toBe('SOURCE_NOT_FOUND');
  });
});

describe('size limits and quota (#113)', () => {
  it('Upload-Length above FILES_MAX_UPLOAD_BYTES is refused before anything is stored', async () => {
    const before = staged().length;
    const path = `${fresh('max')}/a.bin`;
    const r = await create(path, MAX + 1);
    expect(r.statusCode).toBe(413);
    expect(r.json().code).toBe('PAYLOAD_TOO_LARGE');
    expect(staged().length).toBe(before);
    expect(t.db.prepare('SELECT count(*) FROM uploads WHERE path = ?').pluck().get(path)).toBe(0);
  });

  it('Upload-Length above the remaining quota is refused; open uploads count as reserved; streaming re-checks', async () => {
    const t2 = await startTestApp();
    try {
      const s = await login(t2, 'testuser');
      const id2 = (await t2.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id;
      const home = homeRoot(t2.config.dataDir, id2);
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, 'have.bin'), Buffer.alloc(300));
      t2.db.prepare('UPDATE users SET quota_bytes = 1000 WHERE id = ?').run(id2);
      const mk = (len: number, path = '/q.bin') => t2.app.inject({ method: 'POST', url: '/api/v1/uploads',
        headers: { ...auth(s), 'upload-length': String(len), 'upload-metadata': meta({ source: 'home', path }) } });
      const over = await mk(701);
      expect(over.statusCode).toBe(507);
      expect(over.json().code).toBe('QUOTA_EXCEEDED');
      expect(existsSync(join(home, '.files', 'uploads')) ? readdirSync(join(home, '.files', 'uploads')) : []).toEqual([]);
      expect(t2.db.prepare('SELECT count(*) FROM uploads').pluck().get()).toBe(0);
      const ok = await mk(700);
      expect(ok.statusCode).toBe(201);
      // The 700 bytes still to come are reserved: nothing else fits.
      expect((await mk(1, '/r.bin')).json().code).toBe('QUOTA_EXCEEDED');
      // The quota shrinks while the upload is open: the next PATCH is refused and stores nothing.
      t2.db.prepare('UPDATE users SET quota_bytes = 500 WHERE id = ?').run(id2);
      const id = idOf(ok.headers.location);
      const p = await t2.app.inject({ method: 'PATCH', url: `/api/v1/uploads/${id}`,
        headers: { ...auth(s), 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' }, payload: Buffer.alloc(700) });
      expect(p.statusCode).toBe(507);
      expect(p.json().code).toBe('QUOTA_EXCEEDED');
      const h = await t2.app.inject({ method: 'HEAD', url: `/api/v1/uploads/${id}`, headers: auth(s) });
      expect(h.headers['upload-offset']).toBe('0');
      // The plain PUT upload is held to the same quota.
      const put = await t2.app.inject({ method: 'PUT', url: '/api/v1/sources/home/content?path=%2Fp.bin&onCollision=fail',
        headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(300) });
      expect(put.statusCode).toBe(507);
      expect(existsSync(join(home, 'p.bin'))).toBe(false);
    } finally {
      await t2.close();
    }
  });

  it('a client sending more bytes than declared is cut off and leaves nothing behind (declared length)', async () => {
    const path = `${fresh('over')}/a.bin`;
    const id = idOf((await create(path, 10)).headers.location);
    const r = await patch(id, 0, Buffer.alloc(20, 7));
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('SIZE_MISMATCH');
    expect((await head(id)).statusCode).toBe(404);
    expect(staged()).not.toContain(id);
    expect(existsSync(join(root, path))).toBe(false);
  });

  it('a client sending more bytes than declared is cut off and leaves nothing behind (chunked body)', async () => {
    const path = `${fresh('over-chunked')}/a.bin`;
    const id = idOf((await create(path, 1000)).headers.location);
    const r = await rawPatch(id, 0, Readable.from([Buffer.alloc(600, 1), Buffer.alloc(600, 2)]), { 'transfer-encoding': 'chunked' });
    expect(r).not.toBe('aborted');
    if (r === 'aborted') return;
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).code).toBe('SIZE_MISMATCH');
    expect((await head(id)).statusCode).toBe(404);
    expect(staged()).not.toContain(id);
    expect(rows(id)).toEqual([]);
    expect(existsSync(join(root, path))).toBe(false);
  });

  it('a 2 GB upload keeps process memory bounded', async () => {
    const GB = 2 * 1024 ** 3;
    const path = `${fresh('huge')}/huge.bin`;
    const id = idOf((await create(path, GB)).headers.location);
    const block = randomBytes(1 << 20);
    const sent = createHash('sha256');
    async function* body() { for (let i = 0; i < GB / block.length; i++) { sent.update(block); yield block; } }
    global.gc?.();
    const base = process.memoryUsage.rss();
    let peak = base;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 20);
    const r = await rawPatch(id, 0, Readable.from(body()), { 'content-length': String(GB) });
    clearInterval(sampler);
    expect(r).toMatchObject({ status: 204, headers: { 'upload-offset': String(GB) } });
    expect(peak - base).toBeLessThan(200 * 1024 * 1024);
    const got = createHash('sha256');
    await pipeline(createReadStream(join(root, path)), got);
    expect(got.digest('hex')).toBe(sent.digest('hex'));
  }, 180_000);
});

describe('access', () => {
  it('tus routes need a session, and the mutating ones Origin and the CSRF token', async () => {
    const id = idOf((await create(`${fresh('csrf')}/a.bin`, 3)).headers.location);
    expect((await t.app.inject({ method: 'HEAD', url: `/api/v1/uploads/${id}`, headers: { 'tus-resumable': '1.0.0' } })).statusCode).toBe(401);
    const noToken = { cookie: a.cookie, origin: ORIGIN, 'tus-resumable': '1.0.0' };
    const badOrigin = { ...auth(a), origin: 'https://evil.example.com' };
    for (const headers of [noToken, badOrigin]) {
      const c = await t.app.inject({ method: 'POST', url: '/api/v1/uploads',
        headers: { ...headers, 'upload-length': '1', 'upload-metadata': meta({ source: 'home', path: '/x' }) } });
      expect(c.statusCode).toBe(403);
      const p = await t.app.inject({ method: 'PATCH', url: `/api/v1/uploads/${id}`,
        headers: { ...headers, 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' }, payload: Buffer.from('abc') });
      expect(p.statusCode).toBe(403);
      expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/uploads/${id}`, headers })).statusCode).toBe(403);
    }
    expect((await head(id)).headers['upload-offset']).toBe('0');
  });

  it("another member's upload id answers 404 and stays untouched", async () => {
    const id = idOf((await create(`${fresh('mine')}/a.bin`, 3)).headers.location);
    expect((await head(id, b)).statusCode).toBe(404);
    expect((await patch(id, 0, Buffer.from('abc'), b)).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/uploads/${id}`, headers: auth(b) })).statusCode).toBe(404);
    const fin = await t.app.inject({ method: 'POST', url: `/api/v1/uploads/${id}/finish`, headers: auth(b), payload: { onCollision: 'replace' } });
    expect(fin.statusCode).toBe(404);
    expect((await head(id)).headers['upload-offset']).toBe('0');
    expect((await head('0'.repeat(32))).statusCode).toBe(404);
    expect((await head('not-an-id')).statusCode).toBe(404);
  });
});

describe('expiry', () => {
  it('removes expired incomplete uploads with their bytes and keeps fresh ones', async () => {
    const old = idOf((await create(`${fresh('exp')}/a.bin`, 10)).headers.location);
    await patch(old, 0, Buffer.alloc(5));
    const young = idOf((await create(`${fresh('exp')}/b.bin`, 10)).headers.location);
    expect(Date.parse(String((await head(young)).headers['upload-expires']))).toBeGreaterThan(Date.now() + 23 * 3600_000);
    t.db.prepare("UPDATE uploads SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(old);
    const r = await expireUploads(t.app.deps, pino({ level: 'silent' }));
    expect(r.removed).toContain(old);
    expect(r.removed).not.toContain(young);
    expect((await head(old)).statusCode).toBe(404);
    expect(staged()).not.toContain(old);
    expect(rows(old)).toEqual([]);
    expect((await head(young)).statusCode).toBe(200);
    expect(staged()).toContain(young);
  });

  it('runs once at app start (then hourly), like the trash expiry', async () => {
    const uid = '00000000-0000-4000-8000-000000000001'; const id = 'ab'.repeat(16);
    let staging = '';
    const t3 = await startTestApp({}, undefined, undefined, { prepare: (db) => {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO users (id, iss, sub, display_name, email, role, created_at, last_login)
        VALUES (?, 'https://idp.example.com', 'testuser', 'Test User', 'testuser@example.com', 'member', ?, ?)`).run(uid, now, now);
      db.prepare(`INSERT INTO uploads (id, user_id, source, path, length, received, on_collision, created_at, expires_at)
        VALUES (?, ?, 'home', '/a.bin', 4, 2, 'fail', ?, '2000-01-01T00:00:00.000Z')`).run(id, uid, now);
      const dataDir = join(String(db.name), '..');
      staging = join(homeRoot(dataDir, uid), '.files', 'uploads');
      mkdirSync(staging, { recursive: true });
      writeFileSync(join(staging, id), 'ab');
    } });
    try {
      await expect.poll(() => t3.db.prepare('SELECT count(*) FROM uploads WHERE id = ?').pluck().get(id)).toBe(0);
      expect(existsSync(join(staging, id))).toBe(false);
    } finally {
      await t3.close();
    }
  });
});
