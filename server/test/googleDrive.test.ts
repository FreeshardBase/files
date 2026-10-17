import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import type { Connection } from '@files/shared';
import { open } from '../src/cloud/secretBox.ts';
import { MAX_JITTER_MS, type Clock } from '../src/cloud/oauth.ts';
import { ConfigError } from '../src/config.ts';
import { getUser } from '../src/users.ts';
import type { StorageBackend } from '../src/storage/backend.ts';
import { GOOGLE_DRIVE_ENDPOINTS } from '../src/cloud/googleDrive.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { startFakeProvider, type FakeProvider, type FakeRequest } from './support/fakeProvider.ts';
import { DRIVE_CHUNK_UNIT, generatedByte, NATIVE } from './support/fakeDrive.ts';

// #149: the Google Drive backend against the fake Drive server (support/fakeDrive.ts, spec §3.9): listing across pages,
// Range downloads through a 302 to a pre-signed URL, resumable upload sessions, 401 → refresh → retry with a rotated
// refresh token, 429 with Retry-After, deletes into Drive's trash, proxied thumbnails, duplicate names, Google-native
// documents, bounded memory for a 1 GB transfer, and the production provider's fixed Google endpoints.

type S = { cookie: string; csrf: string; id: string };
const ORIGIN = 'https://files.example.com';
const CHUNK = 4 * DRIVE_CHUNK_UNIT; // 1 MiB session chunks, so a 1 GB transfer is 1024 requests
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let t: TestApp; let fake: FakeProvider; let a: S;
let offset = 0;
const sleeps: number[] = [];
const clock: Clock = { now: () => Date.now() + offset, sleep: async (ms) => { sleeps.push(ms); offset += ms; }, random: () => 1 };

const as = (s: S, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => t.app.inject({
  method, url, headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': s.csrf }), ...headers },
  ...(payload !== undefined ? { payload: payload as object } : {}),
});
async function connect(s: S): Promise<string> {
  const r = await as(s, 'POST', '/api/v1/connections/authorize', { provider: 'google-drive' });
  expect(r.statusCode, r.body).toBe(200);
  const back = await fake.consent(r.json().url as string);
  const cb = await as(s, 'GET', back.pathname + back.search);
  const m = /^\/conn:([0-9a-f]{32})$/.exec(String(cb.headers.location));
  expect(m, String(cb.headers.location)).not.toBeNull();
  return m![1]!;
}
const src = (id: string) => `/api/v1/sources/conn:${id}`;
const q = (path: string) => `path=${encodeURIComponent(path)}`;
const list = (id: string, path: string) => as(a, 'GET', `${src(id)}/list?${q(path)}`);
const names = async (id: string, path: string) => {
  const r = await list(id, path);
  expect(r.statusCode, r.body).toBe(200);
  return (r.json().entries as { name: string }[]).map((e) => e.name).sort();
};
const content = (id: string, path: string, headers: Record<string, string> = {}) => as(a, 'GET', `${src(id)}/content?${q(path)}`, undefined, headers);
const put = (id: string, path: string, body: Buffer, onCollision = 'fail') => as(a, 'PUT', `${src(id)}/content?${q(path)}&onCollision=${onCollision}`,
  body, { 'content-type': 'application/octet-stream' });
const since = (n: number) => fake.requests.slice(n);
const qOf = (r: FakeRequest) => new URLSearchParams(r.query ?? '');
const storedRefresh = (id: string) => open(t.config.encryptionKey,
  t.db.prepare('SELECT refresh_token FROM connections WHERE id = ?').pluck().get(id) as string, `connections/${id}/refresh_token`);
async function backendOf(id: string): Promise<StorageBackend> {
  const conn = (await t.app.deps.connections(getUser(t.db, a.id)!)).find((c) => c.id === id);
  if (!conn) throw new Error('no such connection');
  return conn.backend;
}

let png: Buffer;
beforeAll(async () => {
  fake = await startFakeProvider({ pageSize: 2 });
  for (const n of ['one', 'two', 'three', 'four', 'five']) fake.drive.put(`/Docs/${n}.txt`, `bytes of ${n}`);
  png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#c33' } }).png().toBuffer();
  fake.drive.put('/photo.png', png, { mimeType: 'image/png', thumbnail: true });
  fake.drive.put('/range.txt', '0123456789abcdef', { mimeType: 'text/plain' });
  fake.drive.put('/Budget', null, { mimeType: NATIVE.spreadsheet });
  fake.drive.put('/Survey', null, { mimeType: NATIVE.form });
  fake.drive.put('/Notes', null, { mimeType: NATIVE.document,
    thumbnail: await sharp({ create: { width: 300, height: 400, channels: 3, background: '#36c' } }).png().toBuffer() });
  fake.drive.put('/Deck', null, { mimeType: NATIVE.presentation, thumbnail: true }); // a link whose image Drive has not rendered
  fake.drive.put('/Dup/same.txt', 'first');
  fake.drive.put('/Dup/same.txt', 'second');
  fake.drive.put('/big.bin', { generated: 1024 ** 3 });
  t = await startTestApp({}, undefined, undefined, { providers: [fake.driveProvider({ chunkBytes: CHUNK })], clock });
  const s = await login(t, 'testuser');
  a = { ...s, id: (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id as string };
});
afterAll(async () => { await t?.close(); await fake?.close(); });
beforeEach(async () => {
  sleeps.length = 0;
  fake.drive.contentOrigin = undefined;
  fake.drive.persistOnly.length = 0;
  for (const c of (await as(a, 'GET', '/api/v1/connections')).json().items as Connection[]) {
    expect((await as(a, 'DELETE', `/api/v1/connections/${c.id}`)).statusCode).toBe(204);
  }
});

describe('browsing and downloading', () => {
  it('lists a folder across three pages, following nextPageToken to the end', async () => {
    const id = await connect(a);
    const docs = fake.drive.byPath('/Docs')!.id;
    const before = fake.requests.length;
    const r = await list(id, '/Docs');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().entries).toHaveLength(5);
    expect(r.json().entries).toContainEqual(expect.objectContaining({ name: 'one.txt', path: '/Docs/one.txt', type: 'file',
      size: 'bytes of one'.length, mime: 'text/plain' }));
    const pages = since(before).filter((x) => x.path === '/drive/v3/files' && qOf(x).get('q')?.includes(docs));
    expect(pages.map((x) => qOf(x).get('pageToken'))).toEqual([null, '2', '4']);
    expect(await names(id, '/')).toEqual(expect.arrayContaining(['Docs', 'Dup', 'photo.png', 'range.txt']));
  });

  it('downloads whole and by Range through the 302 to a pre-signed URL; an unsatisfiable range is 416', async () => {
    const id = await connect(a);
    const whole = await content(id, '/range.txt');
    expect(whole.statusCode).toBe(200);
    expect(whole.body).toBe('0123456789abcdef');
    expect(whole.headers['content-length']).toBe('16');
    const part = await content(id, '/range.txt', { range: 'bytes=2-5' });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('2345');
    expect(part.headers['content-range']).toBe('bytes 2-5/16');
    const bad = await content(id, '/range.txt', { range: 'bytes=99-' });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe('bytes */16');
    expect((await content(id, '/Docs')).json()).toEqual({ code: 'IS_A_DIRECTORY' });
    expect((await content(id, '/nope.txt')).json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('never follows a content redirect to a host outside the provider\'s fixed ones', async () => {
    const id = await connect(a);
    let hits = 0;
    const foreign = http.createServer((_req, res) => { hits++; res.writeHead(200, { 'content-length': 5 }).end('stolen'.slice(0, 5)); });
    await new Promise<void>((r) => foreign.listen(0, '127.0.0.1', r));
    try {
      fake.drive.contentOrigin = `http://127.0.0.1:${(foreign.address() as AddressInfo).port}`;
      const r = await content(id, '/range.txt');
      expect(r.statusCode).toBe(500);
      expect(r.json()).toEqual({ code: 'INTERNAL' });
      expect(hits).toBe(0);
    } finally { foreign.closeAllConnections(); await new Promise((r) => foreign.close(r)); }
  });

  it('shows two items with the same name as two entries, each reachable; the bare name is ambiguous, never merged', async () => {
    const id = await connect(a);
    const ids = fake.drive.childrenOf(fake.drive.byPath('/Dup')!.id).map((f) => f.id);
    expect(await names(id, '/Dup')).toEqual(ids.map((x) => `same (~${x}).txt`).sort());
    const bodies = await Promise.all(ids.map(async (x) => (await content(id, `/Dup/same (~${x}).txt`)).body));
    expect(bodies.sort()).toEqual(['first', 'second']);
    const bare = await content(id, '/Dup/same.txt');
    expect(bare.statusCode).toBe(409);
    expect(bare.json()).toEqual({ code: 'AMBIGUOUS_NAME', params: { name: 'same.txt' } });
    // Renaming one of them resolves the clash: both are listed by their plain names again.
    const mv = await as(a, 'POST', `${src(id)}/move`, { from: `/Dup/same (~${ids[0]}).txt`, to: '/Dup/renamed.txt', onCollision: 'fail' });
    expect(mv.statusCode, mv.body).toBe(200);
    expect(await names(id, '/Dup')).toEqual(['renamed.txt', 'same.txt']);
    expect((await content(id, '/Dup/same.txt')).statusCode).toBe(200);
  });

  it('lists Google-native documents with an office extension and exports them on download', async () => {
    const id = await connect(a);
    const root = (await list(id, '/')).json().entries as { name: string; mime?: string; size: number }[];
    // Drive cannot tell an export's size before it is made (#236 P4): the entry says so instead of claiming 0 bytes.
    expect(root).toContainEqual(expect.objectContaining({ name: 'Budget.xlsx', type: 'file', mime: XLSX, size: 0, sizeUnknown: true }));
    expect(root).toContainEqual(expect.objectContaining({ name: 'Survey', type: 'file', sizeUnknown: true }));
    expect((await as(a, 'GET', `${src(id)}/stat?path=${encodeURIComponent('/Budget.xlsx')}`)).json()).toMatchObject({ sizeUnknown: true });
    const before = fake.requests.length;
    const r = await content(id, '/Budget.xlsx', { range: 'bytes=0-3' });
    expect(r.statusCode).toBe(200); // an export has no ranges: the whole document
    expect(r.body).toBe(`exported Budget as ${XLSX}`);
    expect(r.headers['content-type']).toBe(XLSX);
    expect(r.headers['content-disposition']).toContain('attachment; filename="Budget.xlsx"');
    expect(r.headers['content-length']).toBeUndefined();
    expect(since(before).some((x) => x.path.endsWith('/export') && qOf(x).get('mimeType') === XLSX)).toBe(true);
    const form = await content(id, '/Survey');
    expect(form.statusCode).toBe(422);
    expect(form.json()).toEqual({ code: 'NOT_EXPORTABLE' });
  });

  it('proxies thumbnails and content: no provider URL reaches the client', async () => {
    const id = await connect(a);
    const before = fake.requests.length;
    const th = await as(a, 'GET', `${src(id)}/thumbnail?${q('/photo.png')}&size=128`);
    expect(th.statusCode, th.body).toBe(200);
    expect(th.headers['content-type']).toBe('image/webp');
    const meta = await sharp(th.rawPayload).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([128, 96]);
    expect(since(before).some((x) => x.path.startsWith('/drive-thumb/') && x.query === 's128')).toBe(true);
    expect((await as(a, 'GET', `${src(id)}/thumbnail?${q('/range.txt')}&size=128`)).json()).toEqual({ code: 'NO_THUMBNAIL' });
    const answers = [th, await list(id, '/'), await as(a, 'GET', `${src(id)}/stat?${q('/photo.png')}`), await content(id, '/photo.png')];
    for (const r of answers) {
      const seen = JSON.stringify(r.headers) + (r.headers['content-type'] === 'application/json; charset=utf-8' ? r.body : '');
      expect(seen).not.toContain(fake.url);
      expect(seen).not.toContain('thumbnailLink');
      expect(r.headers.location).toBeUndefined();
    }
    expect(Buffer.compare((await content(id, '/photo.png')).rawPayload, png)).toBe(0);
  });

  it('thumbnails Google Docs through their docs.google.com/feeds/vt link; the token never reaches the redirected image (#203)', async () => {
    const id = await connect(a);
    const before = fake.requests.length;
    const th = await as(a, 'GET', `${src(id)}/thumbnail?${q('/Notes.docx')}&size=128`);
    expect(th.statusCode, th.body).toBe(200);
    expect(th.headers['content-type']).toBe('image/webp');
    const meta = await sharp(th.rawPayload).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 96, 128]);
    const feed = since(before).filter((x) => x.path === '/feeds/vt');
    expect(feed.map((x) => x.query)).toEqual(['s128']); // the requested size, in `sz`
    expect(feed[0]!.token).toBeTruthy(); // Drive's link of a private file needs the credentialed request
    const signed = since(before).filter((x) => x.path.startsWith('/drive-thumb-signed/'));
    expect(signed).toHaveLength(1);
    expect(signed[0]!.token).toBe('');
    // A link Drive answers 404 for is no thumbnail, not a server error.
    expect((await as(a, 'GET', `${src(id)}/thumbnail?${q('/Deck.pptx')}&size=128`)).json()).toEqual({ code: 'NO_THUMBNAIL' });
  });

  it('follows a thumbnail redirect only to a content host', async () => {
    const id = await connect(a);
    fake.drive.contentOrigin = 'http://127.0.0.1:9';
    const before = fake.requests.length;
    const r = await as(a, 'GET', `${src(id)}/thumbnail?${q('/Notes.docx')}&size=128`);
    expect(r.statusCode).toBe(500);
    expect(since(before).some((x) => x.path === '/feeds/vt')).toBe(true);
    expect(since(before).some((x) => x.path.startsWith('/drive-thumb-signed/'))).toBe(false);
  });
});

describe('changing files', () => {
  it('uploads a file larger than one chunk through a resumable session, creating missing folders', async () => {
    const id = await connect(a);
    const body = randomBytes(2 * CHUNK + 512 * 1024);
    const before = fake.drive.chunks.length; const reqs = fake.requests.length;
    const r = await put(id, '/Uploads/2026/big.bin', body);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toEqual(expect.objectContaining({ name: 'big.bin', path: '/Uploads/2026/big.bin', size: body.length }));
    const total = body.length;
    expect(fake.drive.chunks.slice(before)).toEqual([`bytes 0-${CHUNK - 1}/${total}`, `bytes ${CHUNK}-${2 * CHUNK - 1}/${total}`,
      `bytes ${2 * CHUNK}-${total - 1}/${total}`]);
    expect(since(reqs).some((x) => x.method === 'POST' && x.path === '/upload/drive/v3/files' && qOf(x).get('uploadType') === 'resumable')).toBe(true);
    const f = fake.drive.byPath('/Uploads/2026/big.bin')!;
    expect(Buffer.compare(fake.drive.bytes(f.id), body)).toBe(0);
    expect(Buffer.compare((await content(id, '/Uploads/2026/big.bin')).rawPayload, body)).toBe(0);

    // A taken name: FILE_EXISTS before a session is opened, "keep both" gets a free name, "replace" a new revision.
    const sessions = fake.drive.chunks.length;
    const taken = await put(id, '/Uploads/2026/big.bin', Buffer.from('again'));
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'big.bin' } });
    expect(fake.drive.chunks.length).toBe(sessions);
    expect((await put(id, '/Uploads/2026/big.bin', Buffer.from('both'), 'keep-both')).json().name).toBe('big (1).bin');
    expect((await put(id, '/Uploads/2026/big.bin', Buffer.from('new'), 'replace')).statusCode).toBe(201);
    expect(fake.drive.byPath('/Uploads/2026/big.bin')!.id).toBe(f.id); // same file, new content: a revision
    expect(fake.drive.bytes(f.id).toString()).toBe('new');
    const revs = await (await backendOf(id)).revisions!('/Uploads/2026/big.bin');
    expect(revs.map((x) => x.size)).toEqual([body.length, 3]);
  });

  it('resends from the Range of a 308 when Drive persisted less than the chunk, also of the last one (#204)', async () => {
    const id = await connect(a);
    const body = randomBytes(2 * CHUNK + 512 * 1024);
    const total = body.length;
    const before = fake.drive.chunks.length;
    // The first chunk loses its last 256 KiB, the second keeps an odd 1000 bytes, the third lands whole, the last loses 7.
    const p1 = CHUNK - DRIVE_CHUNK_UNIT; const p2 = p1 + 1000; const p3 = p2 + CHUNK;
    fake.drive.persistOnly.push(p1, 1000, CHUNK, total - p3 - 7);
    const r = await put(id, '/Partial/big.bin', body);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().size).toBe(total);
    expect(fake.drive.chunks.slice(before)).toEqual([`bytes 0-${CHUNK - 1}/${total}`, `bytes ${p1}-${p1 + CHUNK - 1}/${total}`,
      `bytes ${p2}-${p3 - 1}/${total}`, `bytes ${p3}-${total - 1}/${total}`, `bytes ${total - 7}-${total - 1}/${total}`]);
    expect(Buffer.compare(fake.drive.bytes(fake.drive.byPath('/Partial/big.bin')!.id), body)).toBe(0);
  });

  it('a 308 that confirms no new bytes fails the upload and cancels the session instead of looping (#204)', async () => {
    const id = await connect(a);
    const cancelled = fake.drive.cancelled;
    fake.drive.persistOnly.push(0);
    const r = await put(id, '/Stuck/big.bin', randomBytes(CHUNK + 10));
    expect(r.statusCode).toBeGreaterThanOrEqual(500);
    expect(fake.drive.cancelled - cancelled).toBe(1);
    expect(fake.drive.byPath('/Stuck/big.bin')).toBeUndefined();
  });

  it('uploads an empty file as one multipart request, never as a session status query; replace makes a revision (#204)', async () => {
    const id = await connect(a);
    const chunks = fake.drive.chunks.length; const reqs = fake.requests.length;
    const r = await put(id, '/Empty/blank.txt', Buffer.alloc(0));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toEqual(expect.objectContaining({ name: 'blank.txt', path: '/Empty/blank.txt', size: 0 }));
    expect(r.json()).not.toHaveProperty('sizeUnknown'); // a stored empty file has a size: 0 bytes (#236 P4)
    const f = fake.drive.byPath('/Empty/blank.txt')!;
    expect(f.mimeType).toBe('text/plain');
    expect(fake.drive.bytes(f.id).length).toBe(0);
    expect(fake.drive.chunks.length).toBe(chunks);
    const uploads = since(reqs).filter((x) => x.path.startsWith('/upload/'));
    expect(uploads.map((x) => `${x.method} ${qOf(x).get('uploadType')}`)).toEqual(['POST multipart']);

    expect((await put(id, '/Empty/blank.txt', Buffer.from('filled'), 'replace')).statusCode).toBe(201);
    expect((await put(id, '/Empty/blank.txt', Buffer.alloc(0), 'replace')).statusCode).toBe(201);
    expect(fake.drive.byPath('/Empty/blank.txt')!.id).toBe(f.id);
    expect(fake.drive.bytes(f.id).length).toBe(0);
    expect(f.revisions.map((x) => x.size)).toEqual([0, 6, 0]);
    const b = await backendOf(id);
    await expect(b.write('/Empty/liar.txt', Readable.from([Buffer.from('x')]), { onCollision: 'fail', maxBytes: 1e9, size: 0 }))
      .rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    expect(fake.drive.byPath('/Empty/liar.txt')).toBeUndefined();
  });

  it('a body shorter or longer than declared cancels the session and creates nothing', async () => {
    const id = await connect(a);
    const b = await backendOf(id);
    const cancelled = fake.drive.cancelled;
    await expect(b.write('/short.bin', Readable.from([Buffer.from('12345')]), { onCollision: 'fail', maxBytes: 1e9, size: 10 }))
      .rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    await expect(b.write('/long.bin', Readable.from([Buffer.from('12345')]), { onCollision: 'fail', maxBytes: 1e9, size: 3 }))
      .rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    expect(fake.drive.cancelled - cancelled).toBe(2);
    expect(fake.drive.byPath('/short.bin')).toBeUndefined();
    expect(fake.drive.byPath('/long.bin')).toBeUndefined();
    await expect(b.write('/huge.bin', Readable.from([]), { onCollision: 'fail', maxBytes: 10, size: 11 }))
      .rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('delete moves items to Drive\'s trash (the fake sees trashed: true) and never deletes permanently', async () => {
    const id = await connect(a);
    fake.drive.put('/Bin/a.txt', 'a');
    fake.drive.put('/Bin/Sub/b.txt', 'b');
    const fa = fake.drive.byPath('/Bin/a.txt')!; const sub = fake.drive.byPath('/Bin/Sub')!;
    // All or nothing: a missing path keeps every item where it is.
    const partial = await as(a, 'POST', `${src(id)}/delete`, { paths: ['/Bin/a.txt', '/Bin/missing.txt'] });
    expect(partial.statusCode).toBe(404);
    expect(fa.trashed).toBe(false);
    const before = fake.requests.length;
    const r = await as(a, 'POST', `${src(id)}/delete`, { paths: ['/Bin/a.txt', '/Bin/Sub'] });
    expect(r.statusCode, r.body).toBe(204);
    expect(fa.trashed).toBe(true);
    expect(sub.trashed).toBe(true);
    const calls = since(before);
    expect(calls.filter((x) => x.method === 'PATCH' && (x.body as { trashed?: boolean })?.trashed === true).map((x) => x.path).sort())
      .toEqual([`/drive/v3/files/${fa.id}`, `/drive/v3/files/${sub.id}`].sort());
    expect(fake.requests.filter((x) => x.method === 'DELETE' && x.path.startsWith('/drive/'))).toEqual([]);
    expect(await names(id, '/Bin')).toEqual([]);
  });

  it('makes folders, renames, moves and copies (folders recursively) inside the Drive', async () => {
    const id = await connect(a);
    expect((await as(a, 'POST', `${src(id)}/mkdir`, { path: '/Work' })).statusCode).toBe(201);
    const again = await as(a, 'POST', `${src(id)}/mkdir`, { path: '/Work' });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('FILE_EXISTS');
    expect((await put(id, '/Work/a.txt', Buffer.from('A'))).statusCode).toBe(201);
    const op = (kind: string, from: string, to: string, onCollision = 'fail') => as(a, 'POST', `${src(id)}/${kind}`, { from, to, onCollision });
    expect((await op('move', '/Work/a.txt', '/Work/b.txt')).json()).toEqual(expect.objectContaining({ name: 'b.txt', path: '/Work/b.txt' }));
    expect((await op('copy', '/Work/b.txt', '/Work/c.txt')).statusCode).toBe(201);
    expect((await op('copy', '/Work/b.txt', '/Work/c.txt')).json().code).toBe('FILE_EXISTS');
    expect((await op('copy', '/Work/b.txt', '/Work/c.txt', 'keep-both')).json().name).toBe('c (1).txt');
    expect(await names(id, '/Work')).toEqual(['b.txt', 'c (1).txt', 'c.txt']);
    expect((await op('copy', '/Work', '/Work2')).statusCode).toBe(201);
    expect(await names(id, '/Work2')).toEqual(['b.txt', 'c (1).txt', 'c.txt']);
    expect((await content(id, '/Work2/c.txt')).body).toBe('A');
    expect((await op('move', '/Work2', '/Work/Inner')).statusCode).toBe(200);
    expect(await names(id, '/Work')).toEqual(['Inner', 'b.txt', 'c (1).txt', 'c.txt']);
    expect((await op('move', '/Work', '/Work/Inner/Deeper')).json().code).toBe('TARGET_INSIDE_SOURCE');
    // "replace" sends the old target to Drive's trash, never deletes it.
    const old = fake.drive.byPath('/Work/c.txt')!;
    expect((await op('move', '/Work/b.txt', '/Work/c.txt', 'replace')).statusCode).toBe(200);
    expect(old.trashed).toBe(true);
    expect(fake.requests.filter((x) => x.method === 'DELETE' && x.path.startsWith('/drive/'))).toEqual([]);
  });
});

describe('tokens and backoff on Drive requests', () => {
  it('401 → refresh → retry; the rotated refresh token is stored before the retried request', async () => {
    const id = await connect(a);
    expect((await list(id, '/')).statusCode).toBe(200);
    const first = storedRefresh(id);
    let storedAtRetry: string | undefined;
    const grants = fake.refreshGrants();
    fake.onRequest = (x) => { if (x.path.startsWith('/drive/') && fake.refreshGrants() > grants) storedAtRetry ??= storedRefresh(id); };
    fake.expireAccessTokens();
    const before = fake.requests.length;
    try {
      expect((await list(id, '/Docs')).statusCode).toBe(200);
    } finally { fake.onRequest = undefined; }
    const seq = since(before).map((x) => (x.grant ? `token:${x.grant}` : x.path));
    expect(seq.slice(0, 3)).toEqual([expect.stringMatching(/^\/drive\/v3\//), 'token:refresh_token', expect.stringMatching(/^\/drive\/v3\//)]);
    expect(fake.refreshGrants() - grants).toBe(1);
    const second = storedRefresh(id);
    expect(second).not.toBe(first);
    expect(storedAtRetry).toBe(second);
    expect(fake.validRefreshTokens()).toContain(second);
    expect(fake.validRefreshTokens()).not.toContain(first);
  });

  it('waits for Retry-After after a 429 from Drive, then retries', async () => {
    const id = await connect(a);
    expect((await list(id, '/')).statusCode).toBe(200);
    fake.failNext(1, 429, { 'retry-after': '2' });
    expect((await list(id, '/Docs')).statusCode).toBe(200);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
    expect(sleeps[0]).toBeLessThanOrEqual(2000 + MAX_JITTER_MS);
  });
});

describe('search, quota, memory', () => {
  it('search finds Drive items by name with their paths', async () => {
    const id = await connect(a);
    const r = await as(a, 'GET', '/api/v1/search?q=THREE');
    expect(r.statusCode, r.body).toBe(200);
    const group = (r.json().groups as { source: string; items: { path: string }[] }[]).find((g) => g.source === `conn:${id}`);
    expect(group?.items.map((x) => x.path)).toEqual(['/Docs/three.txt']);
  });

  it('reports the Drive quota', async () => {
    const id = await connect(a);
    expect(await (await backendOf(id)).quota!()).toEqual({ used: 1234, total: 15 * 1024 ** 3 });
  });

  it('moves 1 GB down and 1 GB up through the backend with bounded memory', { timeout: 300_000 }, async () => {
    const id = await connect(a);
    const b = await backendOf(id);
    const mem = () => { const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
    const base = mem(); let peak = base;
    const sampler = setInterval(() => { peak = Math.max(peak, mem()); }, 10);
    const GB = 1024 ** 3;
    try {
      const { stream, entry } = await b.read('/big.bin');
      expect(entry.size).toBe(GB);
      let got = 0; let wrong = 0;
      for await (const c of stream) {
        const chunk = c as Buffer;
        if (chunk[0] !== generatedByte(got)) wrong++;
        got += chunk.length;
      }
      expect(got).toBe(GB);
      expect(wrong).toBe(0);

      const md5 = createHash('md5');
      const block = Buffer.alloc(64 * 1024, 7);
      async function* gen() { for (let sent = 0; sent < GB; sent += block.length) { md5.update(block); yield block; } }
      // Drive persists only part of two chunks (#204): the resent bytes must still arrive once, in order.
      fake.drive.persistOnly.push(CHUNK - DRIVE_CHUNK_UNIT, 12345);
      const up = await b.write('/up/big.bin', Readable.from(gen(), { objectMode: false }), { onCollision: 'replace', maxBytes: 2 * GB, size: GB });
      expect(up.size).toBe(GB);
      expect(fake.drive.md5(fake.drive.byPath('/up/big.bin')!.id)).toBe(md5.digest('hex'));
    } finally { clearInterval(sampler); }
    // heapUsed counts uncollected garbage, so leave GC slack; buffering the 1 GB file would still exceed this by far.
    expect(peak - base).toBeLessThan(256 * 1024 ** 2);
  });
});

describe('the production provider', () => {
  it('is offered only with FILES_GOOGLE_CLIENT_ID and _SECRET, and sends members to Google with fixed endpoints', async () => {
    const without = await startTestApp();
    try {
      const s = await login(without);
      expect((await without.app.inject({ url: '/api/v1/connections', headers: { cookie: s.cookie } })).json().providers).toEqual([]);
    } finally { await without.close(); }
    await expect(startTestApp({ FILES_GOOGLE_CLIENT_ID: 'id-only' })).rejects.toBeInstanceOf(ConfigError);
    const g = await startTestApp({ FILES_GOOGLE_CLIENT_ID: 'testclient.apps.googleusercontent.com', FILES_GOOGLE_CLIENT_SECRET: 'test-secret' });
    try {
      const s = await login(g);
      expect((await g.app.inject({ url: '/api/v1/connections', headers: { cookie: s.cookie } })).json().providers)
        .toEqual([{ id: 'google-drive', name: 'Google Drive' }]);
      const r = await g.app.inject({ method: 'POST', url: '/api/v1/connections/authorize', payload: { provider: 'google-drive' },
        headers: { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf } });
      expect(r.statusCode, r.body).toBe(200);
      const u = new URL(r.json().url as string);
      expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(Object.fromEntries(u.searchParams)).toEqual(expect.objectContaining({ client_id: 'testclient.apps.googleusercontent.com',
        scope: 'https://www.googleapis.com/auth/drive', access_type: 'offline', prompt: 'consent', code_challenge_method: 'S256',
        redirect_uri: `${ORIGIN}/api/v1/connections/callback` }));
    } finally { await g.close(); }
  });

  it('takes thumbnails only from Google thumbnail hosts over https (#203)', () => {
    const host = (s: string) => GOOGLE_DRIVE_ENDPOINTS.thumbnailHost(new URL(s));
    expect(host('https://lh3.googleusercontent.com/abc=s220')).toBe(true);
    expect(host('https://docs.google.com/feeds/vt?gd=true&id=x&sz=s220')).toBe(true);
    for (const s of ['http://docs.google.com/feeds/vt', 'https://docs.google.com.example.com/x', 'https://example.com/a=s220',
      'https://www.googleapis.com/drive/v3/files']) expect(host(s), s).toBe(false);
  });
});
