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
import { GRAPH_CHUNK_UNIT } from './support/fakeGraph.ts';

// #151: the Microsoft Graph backend (OneDrive and SharePoint document libraries) against the fake Graph server
// (support/fakeGraph.ts, spec §3.9): listings followed through `@odata.nextLink` (only on the Graph API), the 302 content
// redirect followed on the server (only to content hosts, without the token) and streamed, `createUploadSession` with
// several ranges, an asynchronous copy monitored to completion, 401 → refresh → retry, 429 with Retry-After, deletes into
// the recycle bin, proxied thumbnails, bounded memory for a 1 GB transfer, the SharePoint site and library picker, and
// the production providers.

type S = { cookie: string; csrf: string; id: string };
const ORIGIN = 'https://files.example.com';
const CHUNK = 4 * GRAPH_CHUNK_UNIT; // 1.25 MiB session chunks
const SITE = 'contoso.sharepoint.com,11111111-aaaa,22222222-bbbb';
const LIBRARY = 'b!team-documents';

let t: TestApp; let fake: FakeProvider; let a: S; let m: S;
let offset = 0;
const sleeps: number[] = [];
const clock: Clock = { now: () => Date.now() + offset, sleep: async (ms) => { sleeps.push(ms); offset += ms; }, random: () => 1 };

const as = (s: S, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => t.app.inject({
  method, url, headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': s.csrf }), ...headers },
  ...(payload !== undefined ? { payload: payload as object } : {}),
});
/** Consent at the fake; answers where the callback sends the browser. */
async function consent(s: S, body: object): Promise<string> {
  const r = await as(s, 'POST', '/api/v1/connections/authorize', body);
  expect(r.statusCode, r.body).toBe(200);
  const back = await fake.consent(r.json().url as string);
  const cb = await as(s, 'GET', back.pathname + back.search);
  expect(cb.statusCode, cb.body).toBe(302);
  return String(cb.headers.location);
}
async function connect(s: S = a): Promise<string> {
  const loc = await consent(s, { provider: 'onedrive' });
  const found = /^\/conn:([0-9a-f]{32})$/.exec(loc);
  expect(found, loc).not.toBeNull();
  return found![1]!;
}
const src = (id: string) => `/api/v1/sources/conn:${id}`;
const q = (path: string) => `path=${encodeURIComponent(path)}`;
const list = (id: string, path: string) => as(a, 'GET', `${src(id)}/list?${q(path)}`);
const names = async (id: string, path: string) => {
  const r = await list(id, path);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().next).toBeUndefined();
  return (r.json().entries as { name: string }[]).map((e) => e.name).sort();
};
const content = (id: string, path: string, headers: Record<string, string> = {}) => as(a, 'GET', `${src(id)}/content?${q(path)}`, undefined, headers);
const put = (id: string, path: string, body: Buffer, onCollision = 'fail', headers: Record<string, string> = {}) =>
  as(a, 'PUT', `${src(id)}/content?${q(path)}&onCollision=${onCollision}`, body, { 'content-type': 'application/octet-stream', ...headers });
const op = (id: string, kind: string, from: string, to: string, onCollision = 'fail') => as(a, 'POST', `${src(id)}/${kind}`, { from, to, onCollision });
const since = (n: number) => fake.requests.slice(n);
async function backendOf(id: string, s: S = a): Promise<StorageBackend> {
  const conn = (await t.app.deps.connections(getUser(t.db, s.id)!)).find((c) => c.id === id);
  if (!conn) throw new Error('no such connection');
  return conn.backend;
}
async function connections(s: S = a): Promise<Connection[]> { return (await as(s, 'GET', '/api/v1/connections')).json().items as Connection[]; }

let png: Buffer;
beforeAll(async () => {
  fake = await startFakeProvider({ pageSize: 2 });
  for (const n of ['one', 'two', 'three', 'four', 'five']) fake.graph.put(`/Docs/${n}.txt`, `bytes of ${n}`);
  png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#36c' } }).png().toBuffer();
  fake.graph.put('/photo.png', png, { thumbnail: true });
  fake.graph.put('/range.txt', '0123456789abcdef');
  fake.graph.put('/Grüße & Co/50% #1.txt', 'odd names');
  fake.graph.put('/big.bin', { generated: 1024 ** 3 });
  fake.graph.addSite(SITE, 'Team Site', [[LIBRARY, 'Documents'], ['b!team-archive', 'Archive']]);
  fake.graph.addSite('contoso.sharepoint.com,33333333-cccc,44444444-dddd', 'Marketing', [['b!marketing-assets', 'Assets']]);
  fake.graph.put('/Plans/roadmap.txt', 'from the team library', { drive: LIBRARY });
  t = await startTestApp({}, undefined, undefined, { providers: fake.graphProviders({ chunkBytes: CHUNK }), clock });
  const me = async (name: string) => {
    const s = await login(t, name);
    return { ...s, id: (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id as string };
  };
  a = await me('testuser');
  m = await me('member');
});
afterAll(async () => { await t?.close(); await fake?.close(); });
beforeEach(async () => {
  sleeps.length = 0;
  for (const s of [a, m]) {
    for (const c of await connections(s)) expect((await as(s, 'DELETE', `/api/v1/connections/${c.id}`)).statusCode).toBe(204);
  }
});

describe('browsing and downloading', () => {
  it('connects OneDrive with one consent and lists a folder by following @odata.nextLink to the end', async () => {
    const id = await connect();
    expect(await connections()).toEqual([expect.objectContaining({ id, provider: 'onedrive', providerName: 'OneDrive',
      account: 'testuser@example.com', status: 'ok' })]);
    const before = fake.requests.length;
    const r = await list(id, '/Docs');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().entries).toHaveLength(5);
    expect(r.json().entries).toContainEqual(expect.objectContaining({ name: 'one.txt', path: '/Docs/one.txt', type: 'file',
      size: 'bytes of one'.length, mime: 'text/plain' }));
    const pages = since(before).filter((x) => x.path.endsWith('/children'));
    expect(pages).toHaveLength(3);
    expect((await list(id, '/')).json().entries).toContainEqual(expect.objectContaining({ name: 'Docs', path: '/Docs', type: 'directory' }));
    expect(await names(id, '/Grüße & Co')).toEqual(['50% #1.txt']);
    expect((await list(id, '/nope')).json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('never follows an @odata.nextLink that leaves the Graph API', async () => {
    const id = await connect();
    fake.graph.foreignNextLink = true;
    const before = fake.requests.length;
    const r = await list(id, '/Docs');
    expect(r.statusCode).toBe(500);
    expect(since(before).filter((x) => x.path.startsWith('/elsewhere'))).toEqual([]);
  });

  it('follows the 302 content redirect on the server, without the token, and streams whole files and ranges', async () => {
    const id = await connect();
    const before = fake.requests.length;
    const whole = await content(id, '/range.txt');
    expect(whole.statusCode, whole.body).toBe(200);
    expect(whole.body).toBe('0123456789abcdef');
    expect(whole.headers['content-length']).toBe('16');
    const blobs = since(before).filter((x) => x.path.startsWith('/graph-dl/'));
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.token).toBeUndefined();
    const part = await content(id, '/range.txt', { range: 'bytes=2-5' });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('2345');
    expect(part.headers['content-range']).toBe('bytes 2-5/16');
    const bad = await content(id, '/range.txt', { range: 'bytes=99-' });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe('bytes */16');
    expect((await content(id, '/Docs')).json()).toEqual({ code: 'IS_A_DIRECTORY' });
    expect((await content(id, '/nope.txt')).json()).toEqual({ code: 'NOT_FOUND' });
    expect((await content(id, '/Grüße & Co/50% #1.txt')).body).toBe('odd names');
    expect((await content(id, '/RANGE.TXT')).body).toBe('0123456789abcdef');
    for (const x of [whole, part, await list(id, '/')]) expect(JSON.stringify(x.headers)).not.toContain(fake.url);
  });

  it('refuses a content redirect to a host that is not one of the content hosts', async () => {
    const id = await connect();
    fake.graph.foreignRedirect = true;
    const before = fake.requests.length;
    const r = await content(id, '/range.txt');
    expect(r.statusCode).toBe(500);
    expect(since(before).filter((x) => x.path.startsWith('/graph-dl/'))).toEqual([]);
  });

  it('proxies thumbnails as WebP at the requested size; a file without one is NO_THUMBNAIL', async () => {
    const id = await connect();
    const before = fake.requests.length;
    const th = await as(a, 'GET', `${src(id)}/thumbnail?${q('/photo.png')}&size=128`);
    expect(th.statusCode, th.body).toBe(200);
    expect(th.headers['content-type']).toBe('image/webp');
    const meta = await sharp(th.rawPayload).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 128, 96]);
    expect(since(before).filter((x) => x.path.endsWith('/content') && x.path.includes('/thumbnails/')).map((x) => x.query)).toEqual(['medium']);
    expect((await as(a, 'GET', `${src(id)}/thumbnail?${q('/range.txt')}&size=128`)).json()).toEqual({ code: 'NO_THUMBNAIL' });
    expect(JSON.stringify(th.headers)).not.toContain(fake.url);
  });
});

describe('changing files', () => {
  it('uploads through createUploadSession in several ranges, creating missing folders', async () => {
    const id = await connect();
    const body = randomBytes(2 * CHUNK + 100 * 1024);
    const before = fake.graph.chunks.length;
    const r = await put(id, '/Uploads/2026/big.bin', body);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toEqual(expect.objectContaining({ name: 'big.bin', path: '/Uploads/2026/big.bin', size: body.length }));
    const n = body.length;
    expect(fake.graph.chunks.slice(before)).toEqual([`bytes 0-${CHUNK - 1}/${n}`, `bytes ${CHUNK}-${2 * CHUNK - 1}/${n}`,
      `bytes ${2 * CHUNK}-${n - 1}/${n}`]);
    expect(Buffer.compare(fake.graph.bytes('/Uploads/2026/big.bin'), body)).toBe(0);
    expect(Buffer.compare((await content(id, '/Uploads/2026/big.bin')).rawPayload, body)).toBe(0);

    // A taken name: FILE_EXISTS before a session starts, "keep both" a free name, "replace" a new version.
    const sessions = fake.graph.chunks.length;
    const taken = await put(id, '/Uploads/2026/big.bin', Buffer.from('again'));
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'big.bin' } });
    expect(fake.graph.chunks.length).toBe(sessions);
    expect((await put(id, '/Uploads/2026/BIG.bin', Buffer.from('both'), 'keep-both')).json().name).toBe('BIG (1).bin');
    expect((await put(id, '/Uploads/2026/big.bin', Buffer.from('new'), 'replace')).statusCode).toBe(201);
    expect(fake.graph.bytes('/Uploads/2026/big.bin').toString()).toBe('new');
    const revs = await (await backendOf(id)).revisions!('/Uploads/2026/big.bin');
    expect(revs.map((x) => x.size)).toEqual([body.length, 3]);
    // An empty file has no range to send: it goes up in one request.
    const empty = await put(id, '/Uploads/empty.txt', Buffer.alloc(0));
    expect(empty.statusCode, empty.body).toBe(201);
    expect(fake.graph.bytes('/Uploads/empty.txt').length).toBe(0);
  });

  it('replaces only the version named by If-Match', async () => {
    const id = await connect();
    expect((await put(id, '/Match/m.txt', Buffer.from('v1'))).statusCode).toBe(201);
    const etag = String((await content(id, '/Match/m.txt')).headers.etag);
    expect((await put(id, '/Match/m.txt', Buffer.from('v2'), 'replace', { 'if-match': etag })).statusCode).toBe(201);
    const stale = await put(id, '/Match/m.txt', Buffer.from('v3'), 'replace', { 'if-match': etag });
    expect(stale.statusCode).toBe(412);
    expect(fake.graph.bytes('/Match/m.txt').toString()).toBe('v2');
  });

  it('a body shorter or longer than declared cancels the session, so nothing is created', async () => {
    const id = await connect();
    const b = await backendOf(id);
    const cancelled = fake.graph.cancelledSessions;
    await expect(b.write('/short.bin', Readable.from([Buffer.from('12345')]), { onCollision: 'fail', maxBytes: 1e9, size: 10 }))
      .rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    await expect(b.write('/long.bin', Readable.from([Buffer.from('12345')]), { onCollision: 'fail', maxBytes: 1e9, size: 3 }))
      .rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    expect(fake.graph.cancelledSessions - cancelled).toBe(2);
    await expect(b.write('/nosize.bin', Readable.from([Buffer.from('1')]), { onCollision: 'fail', maxBytes: 1e9 }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(b.write('/huge.bin', Readable.from([Buffer.from('12345678901')]), { onCollision: 'fail', maxBytes: 10, size: 11 }))
      .rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    for (const p of ['/short.bin', '/long.bin', '/nosize.bin', '/huge.bin']) expect(fake.graph.byPath(p)).toBeUndefined();
  });

  it('copies through the asynchronous copy and monitors it to completion', async () => {
    const id = await connect();
    fake.graph.put('/CopySrc/a.txt', 'A');
    fake.graph.put('/CopySrc/Sub/b.txt', 'B');
    const polls = fake.graph.monitorPolls;
    const r = await op(id, 'copy', '/CopySrc', '/CopyDst');
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toEqual(expect.objectContaining({ name: 'CopyDst', path: '/CopyDst', type: 'directory' }));
    expect(fake.graph.monitorPolls - polls).toBe(fake.graph.copyPollsBeforeDone + 1);
    expect(sleeps.length).toBeGreaterThanOrEqual(fake.graph.copyPollsBeforeDone);
    expect(await names(id, '/CopyDst/Sub')).toEqual(['b.txt']);
    expect((await content(id, '/CopyDst/a.txt')).body).toBe('A');
    // A taken name is asked before the copy starts; "keep both" a free name, "replace" sends the old one to the recycle bin.
    expect((await op(id, 'copy', '/CopySrc/a.txt', '/CopyDst/a.txt')).json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'a.txt' } });
    expect((await op(id, 'copy', '/CopySrc/a.txt', '/CopyDst/a.txt', 'keep-both')).json().name).toBe('a (1).txt');
    fake.graph.put('/CopySrc/a.txt', 'A2');
    const recycled = fake.graph.recycled.length;
    expect((await op(id, 'copy', '/CopySrc/a.txt', '/CopyDst/a.txt', 'replace')).statusCode).toBe(201);
    expect((await content(id, '/CopyDst/a.txt')).body).toBe('A2');
    expect(fake.graph.recycled.length - recycled).toBe(1);
    expect((await op(id, 'copy', '/CopySrc', '/CopySrc/Sub/Inner')).json().code).toBe('TARGET_INSIDE_SOURCE');
  });

  it('makes folders, moves and renames, also a rename that only changes the case', async () => {
    const id = await connect();
    expect((await as(a, 'POST', `${src(id)}/mkdir`, { path: '/Work' })).statusCode).toBe(201);
    expect((await as(a, 'POST', `${src(id)}/mkdir`, { path: '/work' })).json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'work' } });
    expect((await put(id, '/Work/a.txt', Buffer.from('A'))).statusCode).toBe(201);
    expect((await op(id, 'move', '/Work/a.txt', '/Work/b.txt')).json()).toEqual(expect.objectContaining({ name: 'b.txt', path: '/Work/b.txt' }));
    expect((await op(id, 'move', '/Work/b.txt', '/Work/B.txt')).json()).toEqual(expect.objectContaining({ name: 'B.txt', path: '/Work/B.txt' }));
    expect(await names(id, '/Work')).toEqual(['B.txt']);
    expect((await as(a, 'POST', `${src(id)}/mkdir`, { path: '/Work/Inner' })).statusCode).toBe(201);
    expect((await op(id, 'move', '/Work/B.txt', '/Work/Inner/B.txt')).statusCode).toBe(200);
    expect((await content(id, '/Work/Inner/B.txt')).body).toBe('A');
    expect((await op(id, 'move', '/Work', '/work/Inner/Deeper')).json().code).toBe('TARGET_INSIDE_SOURCE');
    expect((await put(id, '/Work/c.txt', Buffer.from('C'))).statusCode).toBe(201);
    expect((await op(id, 'move', '/Work/c.txt', '/Work/Inner/B.txt')).json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'B.txt' } });
    const recycled = fake.graph.recycled.length;
    expect((await op(id, 'move', '/Work/c.txt', '/Work/Inner/B.txt', 'replace')).statusCode).toBe(200);
    expect((await content(id, '/Work/Inner/B.txt')).body).toBe('C');
    expect(fake.graph.recycled.length - recycled).toBe(1);
    expect(fake.graph.permanentDeletes).toBe(0);
  });

  it('deletes into the recycle bin, all paths checked first', async () => {
    const id = await connect();
    fake.graph.put('/Bin/a.txt', 'a');
    fake.graph.put('/Bin/Sub/b.txt', 'b');
    const partial = await as(a, 'POST', `${src(id)}/delete`, { paths: ['/Bin/a.txt', '/Bin/missing.txt'] });
    expect(partial.statusCode).toBe(404);
    expect(fake.graph.byPath('/Bin/a.txt')).toBeDefined();
    const recycled = fake.graph.recycled.length;
    const r = await as(a, 'POST', `${src(id)}/delete`, { paths: ['/Bin/a.txt', '/Bin/Sub', '/bin/sub/b.txt'] });
    expect(r.statusCode, r.body).toBe(204);
    expect(fake.graph.recycled.slice(recycled).map((x) => x.name)).toEqual(['a.txt', 'Sub']);
    expect(await names(id, '/Bin')).toEqual([]);
    expect(fake.graph.permanentDeletes).toBe(0);
  });
});

describe('tokens and backoff on Graph requests', () => {
  it('401 → refresh → retry', async () => {
    const id = await connect();
    expect((await list(id, '/')).statusCode).toBe(200);
    const grants = fake.refreshGrants();
    fake.expireAccessTokens();
    const before = fake.requests.length;
    expect((await content(id, '/range.txt')).body).toBe('0123456789abcdef');
    const seq = since(before).map((x) => (x.grant ? `token:${x.grant}` : x.path));
    expect(seq.slice(0, 3)).toEqual([expect.stringMatching(/^\/graph\//), 'token:refresh_token', expect.stringMatching(/^\/graph\//)]);
    expect(fake.refreshGrants() - grants).toBe(1);
  });

  it('waits for Retry-After after a 429 from Graph, then retries', async () => {
    const id = await connect();
    expect((await list(id, '/')).statusCode).toBe(200);
    fake.failNext(1, 429, { 'retry-after': '3' });
    expect((await list(id, '/Docs')).statusCode).toBe(200);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(3000);
    expect(sleeps[0]).toBeLessThanOrEqual(3000 + MAX_JITTER_MS);
  });
});

describe('search, quota, memory', () => {
  it('search finds items by name and gives them their path by walking the parents', async () => {
    const id = await connect();
    const r = await as(a, 'GET', '/api/v1/search?q=THREE');
    expect(r.statusCode, r.body).toBe(200);
    const group = (r.json().groups as { source: string; items: { path: string }[] }[]).find((g) => g.source === `conn:${id}`);
    expect(group?.items.map((x) => x.path)).toEqual(['/Docs/three.txt']);
  });

  it('reports the drive quota', async () => {
    const id = await connect();
    expect(await (await backendOf(id)).quota!()).toEqual({ used: 9876, total: 5 * 1024 ** 3 });
  });

  it('moves 1 GB down and 1 GB up through the backend with bounded memory', { timeout: 300_000 }, async () => {
    const id = await connect();
    const b = await backendOf(id);
    const mem = () => { const x = process.memoryUsage(); return x.heapUsed + x.arrayBuffers; };
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
      expect(fake.graph.md5('/up/big.bin')).toBe(md5.digest('hex'));
    } finally { clearInterval(sampler); }
    // heapUsed counts uncollected garbage, so leave GC slack; buffering the 1 GB file would still exceed this by far.
    expect(peak - base).toBeLessThan(256 * 1024 ** 2);
  });
});

describe('SharePoint: the site and library picker', () => {
  it('a SharePoint consent ends at the picker; the picked library is browsed like the home', async () => {
    const loc = await consent(a, { provider: 'sharepoint' });
    const found = /^\/connections\?pick=([0-9a-f]{32})$/.exec(loc);
    expect(found, loc).not.toBeNull();
    const id = found![1]!;
    expect(await connections()).toEqual([expect.objectContaining({ id, provider: 'sharepoint', providerName: 'SharePoint', status: 'library' })]);
    // No library yet: no files, and no fallback to the account's OneDrive.
    expect((await list(id, '/')).json()).toEqual({ code: 'SOURCE_NOT_FOUND' });

    const sites = await as(a, 'GET', `/api/v1/connections/${id}/sites?q=team`);
    expect(sites.statusCode, sites.body).toBe(200);
    expect(sites.json().items).toEqual([{ id: SITE, name: 'Team Site', url: 'https://contoso.sharepoint.com/sites/TeamSite' }]);
    expect((await as(a, 'GET', `/api/v1/connections/${id}/sites`)).json().items).toHaveLength(2);
    const libs = await as(a, 'GET', `/api/v1/connections/${id}/sites/${encodeURIComponent(SITE)}/libraries`);
    expect(libs.statusCode, libs.body).toBe(200);
    expect(libs.json().items).toEqual([{ id: LIBRARY, name: 'Documents' }, { id: 'b!team-archive', name: 'Archive' }]);

    // A library of another site, or none at all, is not taken.
    expect((await as(a, 'PUT', `/api/v1/connections/${id}/library`, { site: SITE, library: 'b!marketing-assets' })).json())
      .toEqual({ code: 'NOT_FOUND' });
    expect((await as(a, 'PUT', `/api/v1/connections/${id}/library`, { site: SITE, library: 'b!x/../me' })).statusCode).toBe(400);
    // Another member cannot pick for this connection.
    expect((await as(m, 'PUT', `/api/v1/connections/${id}/library`, { site: SITE, library: LIBRARY })).json()).toEqual({ code: 'NOT_FOUND' });
    expect((await as(m, 'GET', `/api/v1/connections/${id}/sites`)).json()).toEqual({ code: 'NOT_FOUND' });

    const pick = await as(a, 'PUT', `/api/v1/connections/${id}/library`, { site: SITE, library: LIBRARY });
    expect(pick.statusCode, pick.body).toBe(200);
    expect(pick.json()).toEqual(expect.objectContaining({ id, status: 'ok', library: 'Team Site / Documents' }));
    expect(await names(id, '/')).toEqual(['Plans']);
    expect((await content(id, '/Plans/roadmap.txt')).body).toBe('from the team library');
    expect((await put(id, '/Plans/notes.txt', Buffer.from('n'))).statusCode).toBe(201);
    expect(fake.graph.bytes('/Plans/notes.txt', LIBRARY).toString()).toBe('n');
    // The library stays: picking again is refused, so shares into it never point elsewhere.
    expect((await as(a, 'PUT', `/api/v1/connections/${id}/library`, { site: SITE, library: 'b!team-archive' })).json())
      .toEqual({ code: 'VALIDATION' });

    // Another consent of the same account adds a second, pending connection; the same library twice is refused.
    const second = /pick=([0-9a-f]{32})$/.exec(await consent(a, { provider: 'sharepoint' }))![1]!;
    expect(second).not.toBe(id);
    expect((await as(a, 'PUT', `/api/v1/connections/${second}/library`, { site: SITE, library: LIBRARY })).json())
      .toEqual({ code: 'LIBRARY_ALREADY_CONNECTED' });
    expect((await as(a, 'PUT', `/api/v1/connections/${second}/library`, { site: SITE, library: 'b!team-archive' })).statusCode).toBe(200);
    // Signing in again keeps each connection's library.
    expect(await consent(a, { connection: id })).toBe(`/conn:${id}`);
    expect((await connections()).map((c) => c.library)).toEqual(['Team Site / Documents', 'Team Site / Archive']);
  });

  it('OneDrive connections have no picker', async () => {
    const id = await connect();
    expect((await as(a, 'GET', `/api/v1/connections/${id}/sites`)).json()).toEqual({ code: 'NOT_FOUND' });
    expect((await as(a, 'PUT', `/api/v1/connections/${id}/library`, { site: SITE, library: LIBRARY })).json()).toEqual({ code: 'NOT_FOUND' });
  });
});

describe('the production providers', () => {
  it('are offered only with FILES_GRAPH_CLIENT_ID and _SECRET, and send members to Microsoft with fixed endpoints', async () => {
    await expect(startTestApp({ FILES_GRAPH_CLIENT_ID: 'id-only' })).rejects.toBeInstanceOf(ConfigError);
    await expect(startTestApp({ FILES_GRAPH_CLIENT_ID: 'i', FILES_GRAPH_CLIENT_SECRET: 's', FILES_GRAPH_TENANT: 'evil.example/x' }))
      .rejects.toBeInstanceOf(ConfigError);
    const d = await startTestApp({ FILES_GRAPH_CLIENT_ID: 'test-app-id', FILES_GRAPH_CLIENT_SECRET: 'test-secret' });
    try {
      const s = await login(d);
      expect((await d.app.inject({ url: '/api/v1/connections', headers: { cookie: s.cookie } })).json().providers)
        .toEqual([{ id: 'onedrive', name: 'OneDrive' }, { id: 'sharepoint', name: 'SharePoint' }]);
      const auth = async (provider: string) => {
        const r = await d.app.inject({ method: 'POST', url: '/api/v1/connections/authorize', payload: { provider },
          headers: { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf } });
        expect(r.statusCode, r.body).toBe(200);
        return new URL(r.json().url as string);
      };
      const one = await auth('onedrive');
      expect(one.origin + one.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
      expect(Object.fromEntries(one.searchParams)).toEqual(expect.objectContaining({ client_id: 'test-app-id',
        code_challenge_method: 'S256', redirect_uri: `${ORIGIN}/api/v1/connections/callback`,
        scope: 'offline_access User.Read Files.ReadWrite' }));
      expect((await auth('sharepoint')).searchParams.get('scope')).toBe('offline_access User.Read Files.ReadWrite.All Sites.Read.All');
    } finally { await d.close(); }
    const tenant = await startTestApp({ FILES_GRAPH_CLIENT_ID: 'i', FILES_GRAPH_CLIENT_SECRET: 's', FILES_GRAPH_TENANT: 'contoso.onmicrosoft.com' });
    try {
      const s = await login(tenant);
      const r = await tenant.app.inject({ method: 'POST', url: '/api/v1/connections/authorize', payload: { provider: 'onedrive' },
        headers: { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf } });
      expect(new URL(r.json().url as string).pathname).toBe('/contoso.onmicrosoft.com/oauth2/v2.0/authorize');
    } finally { await tenant.close(); }
  });
});
