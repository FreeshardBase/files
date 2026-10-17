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

// #211: the pCloud backend against the fake pCloud (support/fakePcloud.ts, spec §3.9): the authorization code flow
// with the region's API host from the callback (allowlisted), a token that never expires and is refused with a
// `result` code in a 200, errors as `result` codes, whole-folder listings, Range downloads from the content host
// `getfilelink` names (allowlisted, never with the token), chunked uploads with bounded memory, folders, moves and
// copies at pCloud, deletes into pCloud's trash, thumbnails, quota, revisions, and the production provider.

type S = { cookie: string; csrf: string; id: string };
const ORIGIN = 'https://files.example.com';
const CHUNK = 1024 * 1024; // 1 MiB upload_write chunks, so a 1 GB transfer is 1024 requests

let t: TestApp; let fake: FakeProvider; let a: S;
let offset = 0;
const sleeps: number[] = [];
const clock: Clock = { now: () => Date.now() + offset, sleep: async (ms) => { sleeps.push(ms); offset += ms; }, random: () => 1 };

const as = (s: S, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => t.app.inject({
  method: method as 'GET', url, headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': s.csrf }), ...headers },
  ...(payload !== undefined ? { payload: payload as object } : {}),
});
/** Starts a consent, plays the fake pCloud's consent page and hands the callback (optionally changed) to the app. */
async function callback(s: S, o: { account?: string; tamper?: (u: URL) => void } = {}) {
  const r = await as(s, 'POST', '/api/v1/connections/authorize', { provider: 'pcloud' });
  expect(r.statusCode, r.body).toBe(200);
  const back = await fake.consent(r.json().url as string, o.account ? { account: o.account } : {});
  o.tamper?.(back);
  return as(s, 'GET', back.pathname + back.search);
}
async function connect(s: S, account?: string): Promise<string> {
  const cb = await callback(s, account ? { account } : {});
  const m = /^\/conn:([0-9a-f]{32})$/.exec(String(cb.headers.location));
  expect(m, String(cb.headers.location)).not.toBeNull();
  return m![1]!;
}
const src = (id: string) => `/api/v1/sources/conn:${id}`;
const q = (path: string) => `path=${encodeURIComponent(path)}`;
const list = (id: string, path: string, cursor?: string) =>
  as(a, 'GET', `${src(id)}/list?${q(path)}${cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
const names = async (id: string, path: string) => {
  const r = await list(id, path);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().next).toBeUndefined();
  return (r.json().entries as { name: string }[]).map((e) => e.name).sort();
};
const content = (id: string, path: string, headers: Record<string, string> = {}) => as(a, 'GET', `${src(id)}/content?${q(path)}`, undefined, headers);
const put = (id: string, path: string, body: Buffer, onCollision = 'fail') => as(a, 'PUT', `${src(id)}/content?${q(path)}&onCollision=${onCollision}`,
  body, { 'content-type': 'application/octet-stream' });
const op = (id: string, kind: string, from: string, to: string, onCollision = 'fail') => as(a, 'POST', `${src(id)}/${kind}`, { from, to, onCollision });
const since = (n: number) => fake.requests.slice(n);
const method = (m: string) => (x: { path: string }) => x.path.endsWith(`/${m}`) && x.path.startsWith('/pcloud/');
const contentHits = (n: number) => since(n).filter((x) => x.path.startsWith('/pcloud-content/'));
async function backendOf(id: string): Promise<StorageBackend> {
  const conn = (await t.app.deps.connections(getUser(t.db, a.id)!)).find((c) => c.id === id);
  if (!conn) throw new Error('no such connection');
  return conn.backend;
}
const connections = async () => (await as(a, 'GET', '/api/v1/connections')).json().items as Connection[];

let png: Buffer;
beforeAll(async () => {
  fake = await startFakeProvider();
  for (const n of ['one', 'two', 'three']) fake.pcloud.put(`/Docs/${n}.txt`, `bytes of ${n}`);
  fake.pcloud.put('/Docs/Inner', null);
  png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#36c' } }).png().toBuffer();
  fake.pcloud.put('/photo.png', png, { thumbnail: true });
  fake.pcloud.put('/range.txt', '0123456789abcdef');
  fake.pcloud.put('/Grüße/übersicht.txt', 'non-ascii');
  fake.pcloud.put('/big.bin', { generated: 1024 ** 3 });
  t = await startTestApp({}, undefined, undefined, { providers: [fake.pcloudProvider({ chunkBytes: CHUNK })], clock });
  const s = await login(t, 'testuser');
  a = { ...s, id: (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id as string };
});
afterAll(async () => { await t?.close(); await fake?.close(); });
beforeEach(async () => {
  sleeps.length = 0;
  fake.pcloud.linkHosts = undefined;
  for (const c of await connections()) expect((await as(a, 'DELETE', `/api/v1/connections/${c.id}`)).statusCode).toBe(204);
});

describe('connecting', () => {
  it('trades the code at the API host of the account\'s region, named by the callback, and keeps using that host', async () => {
    const before = fake.requests.length;
    const us = await connect(a);
    expect(since(before).filter(method('oauth2_token')).map((x) => x.host)).toEqual(['api.pcloud.com']);
    expect((await connections()).find((c) => c.id === us)).toEqual(expect.objectContaining({ provider: 'pcloud', providerName: 'pCloud',
      account: 'testuser@example.com', status: 'ok' }));

    // An EU account: the code, the account lookup and every file request go to eapi.pcloud.com.
    const mark = fake.requests.length;
    const eu = await connect(a, 'acct-member');
    expect(await names(eu, '/Docs')).toEqual(['Inner', 'one.txt', 'three.txt', 'two.txt']);
    const hosts = new Set(since(mark).filter((x) => x.path.startsWith('/pcloud/') && !x.path.startsWith('/pcloud/oauth2/')).map((x) => x.host));
    expect([...hosts]).toEqual(['eapi.pcloud.com']);
    expect((await connections()).find((c) => c.id === eu)?.account).toBe('member@example.com');
  });

  it('refuses a callback whose hostname is not one of pCloud\'s two API hosts, and stores nothing', async () => {
    for (const hostname of ['evil.example.com', 'api.pcloud.com.evil.example.com', '']) {
      const before = fake.requests.length;
      const cb = await callback(a, { tamper: (u) => u.searchParams.set('hostname', hostname) });
      expect(cb.headers.location).toBe('/connections?error=CONNECT_FAILED');
      expect(since(before).filter(method('oauth2_token'))).toEqual([]);
    }
    const cb = await callback(a, { tamper: (u) => u.searchParams.delete('hostname') });
    expect(cb.headers.location).toBe('/connections?error=CONNECT_FAILED');
    // The EU account's code is not valid at the US host: pCloud's `result` error fails the connect.
    const wrong = await callback(a, { account: 'acct-member', tamper: (u) => u.searchParams.set('hostname', 'api.pcloud.com') });
    expect(wrong.headers.location).toBe('/connections?error=CONNECT_FAILED');
    expect(await connections()).toEqual([]);
  });

  it('sends the token as a bearer header, never to a content host; a refused token marks the connection reauth', async () => {
    const id = await connect(a);
    const before = fake.requests.length;
    expect((await content(id, '/range.txt')).body).toBe('0123456789abcdef');
    expect(since(before).filter((x) => x.path.startsWith('/pcloud/')).every((x) => typeof x.token === 'string' && x.token.length > 0)).toBe(true);
    expect(contentHits(before).map((x) => [x.host, x.token])).toEqual([['c123.pcloud.com', undefined]]);

    fake.pcloud.revokeTokens();
    const r = await list(id, '/');
    expect(r.json()).toEqual({ code: 'CONNECTION_REAUTH' });
    expect((await connections()).find((c) => c.id === id)?.status).toBe('reauth');
    // Signing in again brings the same connection back.
    const again = await as(a, 'POST', '/api/v1/connections/authorize', { connection: id });
    const back = await fake.consent(again.json().url as string);
    expect((await as(a, 'GET', back.pathname + back.search)).headers.location).toBe(`/conn:${id}`);
    expect((await connections()).find((c) => c.id === id)?.status).toBe('ok');
    expect((await list(id, '/')).statusCode).toBe(200);
  });
});

describe('browsing and downloading', () => {
  it('lists a whole folder with pCloud\'s times; a cursor is never handed out, so one is refused', async () => {
    const id = await connect(a);
    const r = await list(id, '/Docs');
    expect(r.statusCode, r.body).toBe(200);
    const one = fake.pcloud.items.get('/Docs/one.txt')!;
    expect(r.json().entries).toContainEqual({ name: 'one.txt', path: '/Docs/one.txt', type: 'file', size: 'bytes of one'.length,
      modified: new Date(one.modified).toISOString(), mime: 'text/plain' });
    expect(r.json().entries).toContainEqual(expect.objectContaining({ name: 'Inner', path: '/Docs/Inner', type: 'directory' }));
    expect(r.json().next).toBeUndefined();
    expect(await names(id, '/')).toEqual(['Docs', 'Grüße', 'big.bin', 'photo.png', 'range.txt']);
    expect((await list(id, '/Docs', 'abc')).json()).toEqual({ code: 'VALIDATION' });
    expect((await list(id, '/Nope')).json()).toEqual({ code: 'NOT_FOUND' });
    expect((await list(id, '/range.txt')).json()).toEqual({ code: 'NOT_A_DIRECTORY' });
    const stat = await as(a, 'GET', `${src(id)}/stat?${q('/Docs/Inner')}`);
    expect(stat.json()).toEqual(expect.objectContaining({ name: 'Inner', type: 'directory' }));
  });

  it('downloads whole and by Range from the content host; 416 past the end; a folder IS_A_DIRECTORY', async () => {
    const id = await connect(a);
    const before = fake.requests.length;
    const part = await content(id, '/range.txt', { range: 'bytes=2-5' });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('2345');
    expect(part.headers['content-range']).toBe('bytes 2-5/16');
    expect(since(before).filter(method('getfilelink')).map((x) => x.body)).toEqual([expect.objectContaining({ path: '/range.txt' })]);
    const bad = await content(id, '/range.txt', { range: 'bytes=99-' });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe('bytes */16');
    expect((await content(id, '/Docs')).json()).toEqual({ code: 'IS_A_DIRECTORY' });
    expect((await content(id, '/nope.txt')).json()).toEqual({ code: 'NOT_FOUND' });
    expect((await content(id, '/Grüße/übersicht.txt')).body).toBe('non-ascii');
    // The ETag carries pCloud's 64-bit hash exactly, beyond what a JavaScript number holds.
    const item = fake.pcloud.items.get('/range.txt')!;
    expect(BigInt(item.hash)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect((await content(id, '/range.txt')).headers.etag).toBe(`"${item.id}-${item.hash}"`);
  });

  it('streams only from pCloud content hosts: a link to any other host is never fetched', async () => {
    const id = await connect(a);
    for (const hosts of [['files.evil.example.com'], ['pcloud.com.evil.example.com'], ['api.pcloud.com@evil.example.com']]) {
      fake.pcloud.linkHosts = hosts;
      const before = fake.requests.length;
      const r = await content(id, '/range.txt');
      expect(r.statusCode).toBe(500);
      expect(contentHits(before)).toEqual([]);
    }
    // The first host on the list is taken; one off the list before it is skipped.
    fake.pcloud.linkHosts = ['evil.example.com', 'c9.pcloud.com'];
    const before = fake.requests.length;
    expect((await content(id, '/range.txt')).body).toBe('0123456789abcdef');
    expect(contentHits(before).map((x) => x.host)).toEqual(['c9.pcloud.com']);
  });

  it('proxies pCloud\'s thumbnails as WebP; a file without one is NO_THUMBNAIL without asking', async () => {
    const id = await connect(a);
    const before = fake.requests.length;
    const th = await as(a, 'GET', `${src(id)}/thumbnail?${q('/photo.png')}&size=128`);
    expect(th.statusCode, th.body).toBe(200);
    expect(th.headers['content-type']).toBe('image/webp');
    const meta = await sharp(th.rawPayload).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 128, 96]);
    expect(since(before).filter(method('getthumb')).map((x) => (x.body as Record<string, string>).size)).toEqual(['128x128']);
    const mark = fake.requests.length;
    expect((await as(a, 'GET', `${src(id)}/thumbnail?${q('/range.txt')}&size=128`)).json()).toEqual({ code: 'NO_THUMBNAIL' });
    expect(since(mark).filter(method('getthumb'))).toEqual([]);
  });
});

describe('changing files', () => {
  it('uploads in chunks through upload_create, upload_write and upload_save; collisions as asked', async () => {
    const id = await connect(a);
    const body = randomBytes(2 * CHUNK + 512 * 1024);
    fake.pcloud.put('/Uploads', null);
    const log = fake.pcloud.uploadLog.length;
    const r = await put(id, '/Uploads/big.bin', body);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toEqual(expect.objectContaining({ name: 'big.bin', path: '/Uploads/big.bin', size: body.length }));
    expect(fake.pcloud.uploadLog.slice(log)).toEqual(['create', `write 0+${CHUNK}`, `write ${CHUNK}+${CHUNK}`,
      `write ${2 * CHUNK}+${512 * 1024}`, 'save /Uploads/big.bin']);
    expect(Buffer.compare(fake.pcloud.bytes('/Uploads/big.bin'), body)).toBe(0);
    expect(Buffer.compare((await content(id, '/Uploads/big.bin')).rawPayload, body)).toBe(0);

    // A taken name: FILE_EXISTS before an upload starts, "keep both" a free name, "replace" a new revision.
    const before = fake.pcloud.uploadLog.length;
    const taken = await put(id, '/Uploads/big.bin', Buffer.from('again'));
    expect(taken.json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'big.bin' } });
    expect(fake.pcloud.uploadLog.length).toBe(before);
    expect((await put(id, '/Uploads/big.bin', Buffer.from('both'), 'keep-both')).json().name).toBe('big (1).bin');
    expect((await put(id, '/Uploads/big.bin', Buffer.from('new'), 'replace')).statusCode).toBe(201);
    expect(fake.pcloud.bytes('/Uploads/big.bin').toString()).toBe('new');
    const empty = await put(id, '/Uploads/empty.txt', Buffer.alloc(0));
    expect(empty.json()).toEqual(expect.objectContaining({ size: 0 }));
    expect(fake.pcloud.bytes('/Uploads/empty.txt').length).toBe(0);
  });

  it('replaces only the content named by If-Match', async () => {
    const id = await connect(a);
    fake.pcloud.put('/Match/m.txt', 'v1');
    const etag = String((await content(id, '/Match/m.txt')).headers.etag);
    const ok = await as(a, 'PUT', `${src(id)}/content?${q('/Match/m.txt')}&onCollision=replace`, Buffer.from('v2'),
      { 'content-type': 'application/octet-stream', 'if-match': etag });
    expect(ok.statusCode, ok.body).toBe(201);
    const stale = await as(a, 'PUT', `${src(id)}/content?${q('/Match/m.txt')}&onCollision=replace`, Buffer.from('v3'),
      { 'content-type': 'application/octet-stream', 'if-match': etag });
    expect(stale.statusCode).toBe(412);
    expect(fake.pcloud.bytes('/Match/m.txt').toString()).toBe('v2');
  });

  it('a body shorter or longer than declared is never saved, and its upload is deleted', async () => {
    const id = await connect(a);
    const b = await backendOf(id);
    const log = fake.pcloud.uploadLog.length;
    await expect(b.write('/short.bin', Readable.from([Buffer.from('12345')]), { onCollision: 'fail', maxBytes: 1e9, size: 10 }))
      .rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    await expect(b.write('/long.bin', Readable.from([Buffer.from('12345')]), { onCollision: 'fail', maxBytes: 1e9, size: 3 }))
      .rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    await expect(b.write('/huge.bin', Readable.from([Buffer.from('12345678901')]), { onCollision: 'fail', maxBytes: 10 }))
      .rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    for (const p of ['/short.bin', '/long.bin', '/huge.bin']) expect(fake.pcloud.items.has(p)).toBe(false);
    const steps = fake.pcloud.uploadLog.slice(log);
    expect(steps.filter((s) => s === 'create')).toHaveLength(3);
    expect(steps.filter((s) => s === 'delete')).toHaveLength(3);
    expect(steps.filter((s) => s.startsWith('save'))).toEqual([]);
  });

  it('makes folders, moves and copies at pCloud; a folder never moves into itself; "replace" goes through the trash', async () => {
    const id = await connect(a);
    expect((await as(a, 'POST', `${src(id)}/mkdir`, { path: '/Work' })).statusCode).toBe(201);
    expect((await as(a, 'POST', `${src(id)}/mkdir`, { path: '/Work' })).json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'Work' } });
    expect((await as(a, 'POST', `${src(id)}/mkdir`, { path: '/Missing/Deep' })).json()).toEqual({ code: 'NOT_FOUND' });
    expect((await put(id, '/Work/a.txt', Buffer.from('A'))).statusCode).toBe(201);
    expect((await op(id, 'move', '/Work/a.txt', '/Work/b.txt')).json()).toEqual(expect.objectContaining({ name: 'b.txt', path: '/Work/b.txt' }));
    expect((await op(id, 'copy', '/Work/b.txt', '/Work/c.txt')).statusCode).toBe(201);
    const before = fake.requests.length;
    const copied = await op(id, 'copy', '/Work', '/Work2');
    expect(copied.statusCode, copied.body).toBe(201);
    expect(copied.json()).toEqual(expect.objectContaining({ name: 'Work2', path: '/Work2', type: 'directory' }));
    expect(since(before).filter(method('copyfolder'))).toHaveLength(1);
    expect(await names(id, '/Work2')).toEqual(['b.txt', 'c.txt']);
    expect((await content(id, '/Work2/c.txt')).body).toBe('A');
    expect((await op(id, 'move', '/Work', '/Work/Inner')).json().code).toBe('TARGET_INSIDE_SOURCE');
    expect((await op(id, 'move', '/Work2', '/Moved')).json()).toEqual(expect.objectContaining({ path: '/Moved', type: 'directory' }));
    expect(await names(id, '/Moved')).toEqual(['b.txt', 'c.txt']);
    expect((await op(id, 'move', '/Work/b.txt', '/Work/c.txt')).json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'c.txt' } });
    expect((await op(id, 'copy', '/Work/b.txt', '/Work/c.txt', 'keep-both')).json().name).toBe('c (1).txt');
    expect((await op(id, 'move', '/Work/b.txt', '/Work/c.txt', 'replace')).statusCode).toBe(200);
    expect(fake.pcloud.trash.map((x) => x.path)).toContain('/Work/c.txt');
    expect(await names(id, '/Work')).toEqual(['c (1).txt', 'c.txt']);
  });

  it('deletes into pCloud\'s trash, every path looked up first', async () => {
    const id = await connect(a);
    fake.pcloud.put('/Bin/a.txt', 'a');
    fake.pcloud.put('/Bin/Sub/b.txt', 'b');
    const partial = await as(a, 'POST', `${src(id)}/delete`, { paths: ['/Bin/a.txt', '/Bin/missing.txt'] });
    expect(partial.statusCode).toBe(404);
    expect(fake.pcloud.items.has('/Bin/a.txt')).toBe(true);
    const before = fake.requests.length;
    const r = await as(a, 'POST', `${src(id)}/delete`, { paths: ['/Bin/a.txt', '/Bin/Sub', '/Bin/Sub/b.txt'] });
    expect(r.statusCode, r.body).toBe(204);
    expect(since(before).filter((x) => method('deletefile')(x) || method('deletefolderrecursive')(x))
      .map((x) => `${x.query} ${(x.body as { path: string }).path}`)).toEqual(['deletefile /Bin/a.txt', 'deletefolderrecursive /Bin/Sub']);
    expect(await names(id, '/Bin')).toEqual([]);
    expect(fake.pcloud.trash.map((x) => x.path)).toEqual(expect.arrayContaining(['/Bin/a.txt', '/Bin/Sub']));
  });

  it('lists revisions oldest first with the file itself last, and reverts to one', async () => {
    const id = await connect(a);
    fake.pcloud.put('/Rev/r.txt', 'first');
    expect((await put(id, '/Rev/r.txt', Buffer.from('second!'), 'replace')).statusCode).toBe(201);
    const b = await backendOf(id);
    const revs = await b.revisions!('/Rev/r.txt');
    expect(revs.map((x) => [x.size, x.current ?? false])).toEqual([[5, false], [7, true]]);
    const restored = await b.restoreRevision!('/Rev/r.txt', revs[0]!.id);
    expect(restored).toEqual(expect.objectContaining({ path: '/Rev/r.txt', size: 5 }));
    expect(fake.pcloud.bytes('/Rev/r.txt').toString()).toBe('first');
    expect((await b.revisions!('/Rev/r.txt')).map((x) => x.size)).toEqual([5, 7, 5]);
    await expect(b.restoreRevision!('/Rev/r.txt', '424242')).rejects.toBeTruthy();
  });
});

describe('quota, errors and backoff', () => {
  it('reports the quota from userinfo', async () => {
    const id = await connect(a);
    expect(await (await backendOf(id)).quota!()).toEqual({ used: 52_428_800, total: 10 * 1024 ** 3 });
    const r = await as(a, 'GET', '/api/v1/storage');
    expect(r.statusCode, r.body).toBe(200);
  });

  it('waits for Retry-After after a 429 from pCloud, then retries', async () => {
    const id = await connect(a);
    fake.failNext(1, 429, { 'retry-after': '3' });
    expect((await list(id, '/Docs')).statusCode).toBe(200);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(3000);
    expect(sleeps[0]).toBeLessThanOrEqual(3000 + MAX_JITTER_MS);
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
      const up = await b.write('/up-big.bin', Readable.from(gen(), { objectMode: false }), { onCollision: 'replace', maxBytes: 2 * GB, size: GB });
      expect(up.size).toBe(GB);
      expect(fake.pcloud.md5('/up-big.bin')).toBe(md5.digest('hex'));
    } finally { clearInterval(sampler); }
    // heapUsed counts uncollected garbage, so leave GC slack; buffering the 1 GB file would still exceed this by far.
    expect(peak - base).toBeLessThan(256 * 1024 ** 2);
  });
});

describe('the production provider', () => {
  it('is offered only with FILES_PCLOUD_CLIENT_ID and _SECRET, and sends members to pCloud\'s fixed consent page', async () => {
    await expect(startTestApp({ FILES_PCLOUD_CLIENT_ID: 'id-only' })).rejects.toBeInstanceOf(ConfigError);
    const none = await startTestApp();
    try {
      const s = await login(none);
      expect((await none.app.inject({ url: '/api/v1/connections', headers: { cookie: s.cookie } })).json().providers).toEqual([]);
    } finally { await none.close(); }
    const d = await startTestApp({ FILES_PCLOUD_CLIENT_ID: 'testclientid', FILES_PCLOUD_CLIENT_SECRET: 'test-secret' });
    try {
      const s = await login(d);
      expect((await d.app.inject({ url: '/api/v1/connections', headers: { cookie: s.cookie } })).json().providers)
        .toEqual([{ id: 'pcloud', name: 'pCloud' }]);
      const r = await d.app.inject({ method: 'POST', url: '/api/v1/connections/authorize', payload: { provider: 'pcloud' },
        headers: { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf } });
      expect(r.statusCode, r.body).toBe(200);
      const u = new URL(r.json().url as string);
      expect(u.origin + u.pathname).toBe('https://my.pcloud.com/oauth2/authorize');
      const params = Object.fromEntries(u.searchParams);
      expect(params).toEqual({ client_id: 'testclientid', response_type: 'code', redirect_uri: `${ORIGIN}/api/v1/connections/callback`,
        state: expect.any(String) });
    } finally { await d.close(); }
  });
});
