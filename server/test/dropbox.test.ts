import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import type { Connection } from '@files/shared';
import { MAX_JITTER_MS, type Clock } from '../src/cloud/oauth.ts';
import { ConfigError } from '../src/config.ts';
import { getUser } from '../src/users.ts';
import type { StorageBackend } from '../src/storage/backend.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { startFakeProvider, type FakeProvider } from './support/fakeProvider.ts';
import { generatedByte } from './support/fakeDrive.ts';

// #150: the Dropbox backend against the fake Dropbox server (support/fakeDropbox.ts, spec §3.9): `list_folder` and
// `list_folder/continue` with the cursor handed through, Range downloads, upload sessions over several chunks,
// 401 → refresh → retry, 429 with Retry-After, case-insensitive paths (a rename that only changes case), deletes into
// Dropbox's deleted files, proxied thumbnails, bounded memory for a 1 GB transfer, and the production provider.

type S = { cookie: string; csrf: string; id: string };
const ORIGIN = 'https://files.example.com';
const CHUNK = 1024 * 1024; // 1 MiB session chunks, so a 1 GB transfer is 1024 requests

let t: TestApp; let fake: FakeProvider; let a: S;
let offset = 0;
const sleeps: number[] = [];
const clock: Clock = { now: () => Date.now() + offset, sleep: async (ms) => { sleeps.push(ms); offset += ms; }, random: () => 1 };

const as = (s: S, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => t.app.inject({
  method, url, headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': s.csrf }), ...headers },
  ...(payload !== undefined ? { payload: payload as object } : {}),
});
async function connect(s: S): Promise<string> {
  const r = await as(s, 'POST', '/api/v1/connections/authorize', { provider: 'dropbox' });
  expect(r.statusCode, r.body).toBe(200);
  const back = await fake.consent(r.json().url as string);
  const cb = await as(s, 'GET', back.pathname + back.search);
  const m = /^\/conn:([0-9a-f]{32})$/.exec(String(cb.headers.location));
  expect(m, String(cb.headers.location)).not.toBeNull();
  return m![1]!;
}
const src = (id: string) => `/api/v1/sources/conn:${id}`;
const q = (path: string) => `path=${encodeURIComponent(path)}`;
const list = (id: string, path: string, cursor?: string) =>
  as(a, 'GET', `${src(id)}/list?${q(path)}${cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
/** Every name of a folder, following `next` like the SPA does. */
async function names(id: string, path: string): Promise<string[]> {
  const out: string[] = []; let cursor: string | undefined;
  do {
    const r = await list(id, path, cursor);
    expect(r.statusCode, r.body).toBe(200);
    out.push(...(r.json().entries as { name: string }[]).map((e) => e.name));
    cursor = r.json().next as string | undefined;
  } while (cursor);
  return out.sort();
}
const content = (id: string, path: string, headers: Record<string, string> = {}) => as(a, 'GET', `${src(id)}/content?${q(path)}`, undefined, headers);
const put = (id: string, path: string, body: Buffer, onCollision = 'fail') => as(a, 'PUT', `${src(id)}/content?${q(path)}&onCollision=${onCollision}`,
  body, { 'content-type': 'application/octet-stream' });
const op = (id: string, kind: string, from: string, to: string, onCollision = 'fail') => as(a, 'POST', `${src(id)}/${kind}`, { from, to, onCollision });
const since = (n: number) => fake.requests.slice(n);
const dbx = (endpoint: string) => (x: { path: string }) => x.path.endsWith(`/2/${endpoint}`);
async function backendOf(id: string): Promise<StorageBackend> {
  const conn = (await t.app.deps.connections(getUser(t.db, a.id)!)).find((c) => c.id === id);
  if (!conn) throw new Error('no such connection');
  return conn.backend;
}

let png: Buffer;
beforeAll(async () => {
  fake = await startFakeProvider({ pageSize: 2 });
  for (const n of ['one', 'two', 'three', 'four', 'five']) fake.dropbox.put(`/Docs/${n}.txt`, `bytes of ${n}`);
  png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#36c' } }).png().toBuffer();
  fake.dropbox.put('/photo.png', png, { thumbnail: true });
  fake.dropbox.put('/range.txt', '0123456789abcdef');
  fake.dropbox.put('/Grüße/übersicht.txt', 'non-ascii');
  fake.dropbox.put('/big.bin', { generated: 1024 ** 3 });
  fake.dropbox.unmounted.push({ id: 'id:unmountedthree', name: 'Three of us (shared)' }); // search hit without a path (#205)
  t = await startTestApp({}, undefined, undefined, { providers: [fake.dropboxProvider({ chunkBytes: CHUNK })], clock });
  const s = await login(t, 'testuser');
  a = { ...s, id: (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id as string };
});
afterAll(async () => { await t?.close(); await fake?.close(); });
beforeEach(async () => {
  sleeps.length = 0;
  for (const c of (await as(a, 'GET', '/api/v1/connections')).json().items as Connection[]) {
    expect((await as(a, 'DELETE', `/api/v1/connections/${c.id}`)).statusCode).toBe(204);
  }
});

describe('browsing and downloading', () => {
  it('lists a folder through list_folder and list_folder/continue, handing the cursor to the client', async () => {
    const id = await connect(a);
    const before = fake.requests.length;
    const first = await list(id, '/Docs');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().entries).toHaveLength(2);
    expect(first.json().entries[0]).toEqual(expect.objectContaining({ name: 'five.txt', path: '/Docs/five.txt', type: 'file',
      size: 'bytes of five'.length, mime: 'text/plain' }));
    const next = first.json().next as string;
    expect(typeof next).toBe('string');
    const second = await list(id, '/Docs', next);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().entries.map((e: { name: string }) => e.name)).toEqual(['one.txt', 'three.txt']);
    expect(since(before).filter(dbx('files/list_folder')).map((x) => x.body)).toEqual([expect.objectContaining({ path: '/Docs' })]);
    expect(since(before).filter(dbx('files/list_folder/continue'))).toHaveLength(1);
    expect(await names(id, '/Docs')).toEqual(['five.txt', 'four.txt', 'one.txt', 'three.txt', 'two.txt']);
    // The root is Dropbox's "" path; a folder has no modified time at Dropbox, so none is made up.
    const root = (await list(id, '/')).json();
    expect(root.entries).toContainEqual({ name: 'Docs', path: '/Docs', type: 'directory', size: 0 });
  });

  it('refuses a cursor that was handed out for another folder', async () => {
    const id = await connect(a);
    const next = (await list(id, '/Docs')).json().next as string;
    const before = fake.requests.length;
    const r = await list(id, '/', next);
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ code: 'VALIDATION' });
    expect(since(before).filter(dbx('files/list_folder/continue'))).toEqual([]);
    expect((await list(id, '/Docs', 'not-a-cursor')).json()).toEqual({ code: 'VALIDATION' });
  });

  it('downloads whole and by Range; an unsatisfiable range is 416, a folder IS_A_DIRECTORY', async () => {
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

  it('finds paths regardless of case, as Dropbox does, and sends non-ASCII paths escaped in Dropbox-API-Arg', async () => {
    const id = await connect(a);
    expect((await content(id, '/RANGE.TXT')).body).toBe('0123456789abcdef');
    expect(await names(id, '/docs')).toHaveLength(5);
    const r = await content(id, '/Grüße/übersicht.txt');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toBe('non-ascii');
    expect(await names(id, '/Grüße')).toEqual(['übersicht.txt']);
  });

  it('proxies thumbnails as WebP at the requested size; a type without one is NO_THUMBNAIL', async () => {
    const id = await connect(a);
    const before = fake.requests.length;
    const th = await as(a, 'GET', `${src(id)}/thumbnail?${q('/photo.png')}&size=128`);
    expect(th.statusCode, th.body).toBe(200);
    expect(th.headers['content-type']).toBe('image/webp');
    const meta = await sharp(th.rawPayload).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 128, 96]);
    expect(since(before).filter(dbx('files/get_thumbnail_v2')).map((x) => x.query)).toEqual(['w128h128']);
    expect((await as(a, 'GET', `${src(id)}/thumbnail?${q('/range.txt')}&size=128`)).json()).toEqual({ code: 'NO_THUMBNAIL' });
    for (const r of [th, await list(id, '/'), await content(id, '/photo.png')]) expect(JSON.stringify(r.headers)).not.toContain(fake.url);
  });
});

describe('changing files', () => {
  it('uploads a file larger than one chunk through an upload session', async () => {
    const id = await connect(a);
    const body = randomBytes(2 * CHUNK + 512 * 1024);
    const before = fake.dropbox.chunks.length;
    const r = await put(id, '/Uploads/2026/big.bin', body);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toEqual(expect.objectContaining({ name: 'big.bin', path: '/Uploads/2026/big.bin', size: body.length }));
    expect(fake.dropbox.chunks.slice(before)).toEqual([`start 0+${CHUNK}`, `append ${CHUNK}+${CHUNK}`, `finish ${2 * CHUNK}+${512 * 1024}`]);
    expect(Buffer.compare(fake.dropbox.bytes('/Uploads/2026/big.bin'), body)).toBe(0);
    expect(Buffer.compare((await content(id, '/Uploads/2026/big.bin')).rawPayload, body)).toBe(0);

    // A taken name: FILE_EXISTS before a session starts, "keep both" a free name, "replace" a new revision.
    const sessions = fake.dropbox.chunks.length;
    const taken = await put(id, '/Uploads/2026/big.bin', Buffer.from('again'));
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'big.bin' } });
    expect(fake.dropbox.chunks.length).toBe(sessions);
    expect((await put(id, '/Uploads/2026/big.bin', Buffer.from('both'), 'keep-both')).json().name).toBe('big (1).bin');
    expect((await put(id, '/Uploads/2026/big.bin', Buffer.from('new'), 'replace')).statusCode).toBe(201);
    expect(fake.dropbox.bytes('/Uploads/2026/big.bin').toString()).toBe('new');
    const revs = await (await backendOf(id)).revisions!('/Uploads/2026/big.bin');
    expect(revs.map((x) => x.size)).toEqual([body.length, 3]);
  });

  it('replaces only the revision named by If-Match', async () => {
    const id = await connect(a);
    expect((await put(id, '/Match/m.txt', Buffer.from('v1'))).statusCode).toBe(201);
    const etag = String((await content(id, '/Match/m.txt')).headers.etag);
    const ok = await as(a, 'PUT', `${src(id)}/content?${q('/Match/m.txt')}&onCollision=replace`, Buffer.from('v2'),
      { 'content-type': 'application/octet-stream', 'if-match': etag });
    expect(ok.statusCode, ok.body).toBe(201);
    const stale = await as(a, 'PUT', `${src(id)}/content?${q('/Match/m.txt')}&onCollision=replace`, Buffer.from('v3'),
      { 'content-type': 'application/octet-stream', 'if-match': etag });
    expect(stale.statusCode).toBe(412);
    expect(fake.dropbox.bytes('/Match/m.txt').toString()).toBe('v2');
  });

  it('a body shorter or longer than declared never finishes the session, so nothing is created', async () => {
    const id = await connect(a);
    const b = await backendOf(id);
    await expect(b.write('/short.bin', Readable.from([Buffer.from('12345')]), { onCollision: 'fail', maxBytes: 1e9, size: 10 }))
      .rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    await expect(b.write('/long.bin', Readable.from([Buffer.from('12345')]), { onCollision: 'fail', maxBytes: 1e9, size: 3 }))
      .rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    await expect(b.write('/huge.bin', Readable.from([Buffer.from('12345678901')]), { onCollision: 'fail', maxBytes: 10 }))
      .rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    for (const p of ['/short.bin', '/long.bin', '/huge.bin']) expect(fake.dropbox.byPath(p)).toBeUndefined();
  });

  it('renames a.txt to A.txt although Dropbox paths ignore case, and never deletes the file on the way', async () => {
    const id = await connect(a);
    fake.dropbox.put('/Case/a.txt', 'lower');
    fake.dropbox.put('/Case/b.txt', 'bee');
    const deleted = fake.dropbox.deleted.length;
    const r = await op(id, 'move', '/Case/a.txt', '/Case/A.txt');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual(expect.objectContaining({ name: 'A.txt', path: '/Case/A.txt' }));
    expect(await names(id, '/Case')).toEqual(['A.txt', 'b.txt']);
    expect(fake.dropbox.byPath('/Case/a.txt')!.name).toBe('A.txt');
    // Under "replace" too: the file in the way is the file itself.
    expect((await op(id, 'move', '/Case/b.txt', '/Case/B.txt', 'replace')).statusCode).toBe(200);
    expect(await names(id, '/Case')).toEqual(['A.txt', 'B.txt']);
    expect((await content(id, '/Case/B.txt')).body).toBe('bee');
    expect(fake.dropbox.deleted.length).toBe(deleted);
    // Another item whose name differs only in case is in the way.
    expect((await op(id, 'move', '/Case/A.txt', '/Case/b.txt')).json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'b.txt' } });
    expect((await op(id, 'copy', '/Case/A.txt', '/Case/B.txt', 'keep-both')).json().name).toBe('B (1).txt');
    // "B (1).txt" takes "b (1).txt" as well.
    expect((await op(id, 'copy', '/Case/A.txt', '/Case/b.txt', 'keep-both')).json().name).toBe('b (2).txt');
    expect((await op(id, 'copy', '/Case/A.txt', '/Case/a.txt')).json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'a.txt' } });
    // Copying onto itself in another case under "replace" leaves the file as it is.
    expect((await op(id, 'copy', '/Case/A.txt', '/Case/a.txt', 'replace')).statusCode).toBe(201);
    expect((await content(id, '/Case/A.txt')).body).toBe('lower');
    expect(fake.dropbox.deleted.length).toBe(deleted);
  });

  it('makes folders, moves and copies inside Dropbox; a folder never moves into itself, whatever the case', async () => {
    const id = await connect(a);
    expect((await as(a, 'POST', `${src(id)}/mkdir`, { path: '/Work' })).statusCode).toBe(201);
    expect((await as(a, 'POST', `${src(id)}/mkdir`, { path: '/work' })).json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'work' } });
    expect((await put(id, '/Work/a.txt', Buffer.from('A'))).statusCode).toBe(201);
    expect((await op(id, 'move', '/Work/a.txt', '/Work/b.txt')).json()).toEqual(expect.objectContaining({ name: 'b.txt', path: '/Work/b.txt' }));
    expect((await op(id, 'copy', '/Work/b.txt', '/Work/c.txt')).statusCode).toBe(201);
    expect((await op(id, 'copy', '/Work', '/Work2')).statusCode).toBe(201);
    expect(await names(id, '/Work2')).toEqual(['b.txt', 'c.txt']);
    expect((await content(id, '/Work2/c.txt')).body).toBe('A');
    expect((await op(id, 'move', '/Work', '/work/Inner')).json().code).toBe('TARGET_INSIDE_SOURCE');
    // "replace" sends the item in the way to Dropbox's deleted files, never deletes it permanently.
    expect((await op(id, 'move', '/Work/b.txt', '/Work/c.txt', 'replace')).statusCode).toBe(200);
    expect(fake.dropbox.deleted.map((x) => x.path)).toContain('/Work/c.txt');
    expect(fake.dropbox.permanentDeletes).toBe(0);
  });

  it('deletes into Dropbox\'s deleted files, all paths checked first', async () => {
    const id = await connect(a);
    fake.dropbox.put('/Bin/a.txt', 'a');
    fake.dropbox.put('/Bin/Sub/b.txt', 'b');
    const partial = await as(a, 'POST', `${src(id)}/delete`, { paths: ['/Bin/a.txt', '/Bin/missing.txt'] });
    expect(partial.statusCode).toBe(404);
    expect(fake.dropbox.byPath('/Bin/a.txt')).toBeDefined();
    const before = fake.requests.length;
    const r = await as(a, 'POST', `${src(id)}/delete`, { paths: ['/Bin/a.txt', '/Bin/Sub', '/bin/sub/b.txt'] });
    expect(r.statusCode, r.body).toBe(204);
    expect(since(before).filter(dbx('files/delete_v2')).map((x) => (x.body as { path: string }).path)).toEqual(['/Bin/a.txt', '/Bin/Sub']);
    expect(await names(id, '/Bin')).toEqual([]);
    expect(fake.dropbox.permanentDeletes).toBe(0);
  });
});

describe('tokens and backoff on Dropbox requests', () => {
  it('401 → refresh → retry', async () => {
    const id = await connect(a);
    expect((await list(id, '/')).statusCode).toBe(200);
    const grants = fake.refreshGrants();
    fake.expireAccessTokens();
    const before = fake.requests.length;
    expect((await content(id, '/range.txt')).body).toBe('0123456789abcdef');
    const seq = since(before).map((x) => (x.grant ? `token:${x.grant}` : x.path));
    expect(seq.slice(0, 3)).toEqual([expect.stringMatching(/^\/dropbox\//), 'token:refresh_token', expect.stringMatching(/^\/dropbox\//)]);
    expect(fake.refreshGrants() - grants).toBe(1);
  });

  it('waits for Retry-After after a 429 from Dropbox, then retries', async () => {
    const id = await connect(a);
    expect((await list(id, '/')).statusCode).toBe(200);
    fake.failNext(1, 429, { 'retry-after': '3' });
    expect((await list(id, '/Docs')).statusCode).toBe(200);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(3000);
    expect(sleeps[0]).toBeLessThanOrEqual(3000 + MAX_JITTER_MS);
  });
});

describe('search, quota, memory', () => {
  it('search finds Dropbox items by name with their paths', async () => {
    const id = await connect(a);
    const r = await as(a, 'GET', '/api/v1/search?q=THREE');
    expect(r.statusCode, r.body).toBe(200);
    const group = (r.json().groups as { source: string; items: { path: string }[] }[]).find((g) => g.source === `conn:${id}`);
    expect(group?.items.map((x) => x.path)).toEqual(['/Docs/three.txt']);
  });

  it('skips search hits without a path, such as an unmounted shared folder, and keeps the rest of the page (#205)', async () => {
    const id = await connect(a);
    const r = await as(a, 'GET', '/api/v1/search?q=three');
    expect(r.statusCode, r.body).toBe(200);
    const group = (r.json().groups as { source: string; items?: { path: string }[]; error?: unknown }[]).find((g) => g.source === `conn:${id}`);
    expect(group?.error).toBeUndefined();
    // One page held both: the unmounted folder and the file with a path.
    expect(group?.items?.map((x) => x.path)).toEqual(['/Docs/three.txt']);
  });

  it('reports the Dropbox quota', async () => {
    const id = await connect(a);
    expect(await (await backendOf(id)).quota!()).toEqual({ used: 4321, total: 2 * 1024 ** 3 });
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
      const up = await b.write('/up/big.bin', Readable.from(gen(), { objectMode: false }), { onCollision: 'replace', maxBytes: 2 * GB, size: GB });
      expect(up.size).toBe(GB);
      expect(fake.dropbox.md5('/up/big.bin')).toBe(md5.digest('hex'));
    } finally { clearInterval(sampler); }
    // heapUsed counts uncollected garbage, so leave GC slack; buffering the 1 GB file would still exceed this by far.
    expect(peak - base).toBeLessThan(256 * 1024 ** 2);
  });
});

describe('the production provider', () => {
  it('is offered only with FILES_DROPBOX_CLIENT_ID and _SECRET, and sends members to Dropbox with fixed endpoints', async () => {
    await expect(startTestApp({ FILES_DROPBOX_CLIENT_ID: 'id-only' })).rejects.toBeInstanceOf(ConfigError);
    const d = await startTestApp({ FILES_DROPBOX_CLIENT_ID: 'testappkey', FILES_DROPBOX_CLIENT_SECRET: 'test-secret' });
    try {
      const s = await login(d);
      expect((await d.app.inject({ url: '/api/v1/connections', headers: { cookie: s.cookie } })).json().providers)
        .toEqual([{ id: 'dropbox', name: 'Dropbox' }]);
      const r = await d.app.inject({ method: 'POST', url: '/api/v1/connections/authorize', payload: { provider: 'dropbox' },
        headers: { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf } });
      expect(r.statusCode, r.body).toBe(200);
      const u = new URL(r.json().url as string);
      expect(u.origin + u.pathname).toBe('https://www.dropbox.com/oauth2/authorize');
      expect(Object.fromEntries(u.searchParams)).toEqual(expect.objectContaining({ client_id: 'testappkey', token_access_type: 'offline',
        code_challenge_method: 'S256', redirect_uri: `${ORIGIN}/api/v1/connections/callback`,
        scope: 'account_info.read files.metadata.read files.content.read files.content.write' }));
    } finally { await d.close(); }
  });
});
