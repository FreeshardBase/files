import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { homeRoot } from '../src/paths.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import type { ConnectedBackend } from '../src/storage/backend.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { MemBackend } from './support/memBackend.ts';
import { basic, createAppPassword } from './support/dav.ts';

// #320: Files keeps a reserve free on its data volume, max(5 GiB, 5 % of the volume) or FILES_DISK_RESERVE, so a member
// never fills the shard's disk. Every write is refused with STORAGE_FULL (507) before a byte is accepted once it would
// leave less than the reserve free; deleting, emptying the trash and revoking links stay allowed. The volume's figures
// come from a fake free-space provider here.

type S = { cookie: string; csrf: string; id: string };
type Job = { id: string; status: string; done: number; failed: { path: string; code: string }[] };
const ORIGIN = 'https://files.example.com';
const KiB = 1024; const MiB = 1024 ** 2; const GiB = 1024 ** 3;

const as = (t: TestApp, s: S, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => t.app.inject({
  method: method as 'GET', url,
  headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': s.csrf }), ...headers },
  ...(payload !== undefined ? { payload: payload as object } : {}),
});
async function signIn(t: TestApp, user: string): Promise<S> {
  const s = await login(t, user);
  return { ...s, id: (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id as string };
}
const b64 = (v: string) => Buffer.from(v).toString('base64');
const putBytes = (t: TestApp, s: S, path: string, bytes: Buffer, onCollision = 'fail') => as(t, s, 'PUT',
  `/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=${onCollision}`, bytes, { 'content-type': 'application/octet-stream' });
const tusCreate = (t: TestApp, s: S, path: string, length: number) => as(t, s, 'POST', '/api/v1/uploads', undefined,
  { 'tus-resumable': '1.0.0', 'upload-length': String(length), 'upload-metadata': `source ${b64('home')},path ${b64(path)}` });
const uploadId = (location: unknown) => String(location).split('/').pop()!;

/** A PUT without Content-Length that never ends its body (as in storage.test.ts); the answer decides the test. */
async function chunkedPut(t: TestApp, path: string, headers: Record<string, string>, bytes: number) {
  if (!t.app.server.listening) await t.app.listen({ port: 0, host: '127.0.0.1' });
  const req = http.request({ port: (t.app.server.address() as AddressInfo).port, host: '127.0.0.1', method: 'PUT', path,
    headers: { ...headers, 'transfer-encoding': 'chunked' } });
  req.on('error', () => undefined); // handled: the destroy below aborts the unfinished body; the response decides the test
  const answered = once(req, 'response');
  req.write(Buffer.alloc(bytes));
  try {
    const [res] = (await Promise.race([answered,
      new Promise((_, rej) => setTimeout(() => rej(new Error('no answer to the chunked PUT')), 3000))])) as [http.IncomingMessage];
    const body = await new Promise<string>((resolve) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(b)); });
    return { statusCode: res.statusCode, body };
  } finally { req.destroy(); }
}
// No file at `path` and no staged upload left behind anywhere in the home.
const leftNothing = (root: string, name: string) => {
  expect(existsSync(join(root, name))).toBe(false);
  expect(readdirSync(root, { recursive: true }).map(String).filter((n) => n.endsWith('.upload'))).toEqual([]);
};
async function settled(t: TestApp, s: S, id: string): Promise<Job> {
  const end = Date.now() + 10_000;
  for (;;) {
    const j = (await as(t, s, 'GET', `/api/v1/transfers/${id}`)).json() as Job;
    if (j.status !== 'running') return j;
    if (Date.now() > end) throw new Error(`job ${id} did not settle`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const full = (r: { statusCode?: number; body: string }) => {
  expect(r.statusCode, r.body).toBe(507);
  expect(JSON.parse(r.body).code).toBe('STORAGE_FULL');
};

describe('the disk reserve refuses writes (#320)', () => {
  // A 100 MiB volume with a 10 MiB reserve; each test starts with 12 MiB free, so 2 MiB may still be written.
  const disk = { total: 100 * MiB, free: 12 * MiB };
  let t: TestApp; let admin: S; let member: S; let root: string;
  const conns = new Map<string, ConnectedBackend[]>();

  beforeAll(async () => {
    t = await startTestApp({ FILES_DISK_RESERVE: '10MiB' }, undefined, undefined,
      { diskSpace: async () => ({ ...disk }), connections: async (u) => conns.get(u.id) ?? [] });
    admin = await signIn(t, 'testuser');
    member = await signIn(t, 'member');
    root = homeRoot(t.config.dataDir, member.id);
    mkdirSync(root, { recursive: true });
    const cloud = new MemBackend();
    cloud.put('/three.bin', Buffer.alloc(3 * MiB, 7));
    conns.set(member.id, [{ id: 'cloud1', backend: cloud }]);
  });
  afterAll(async () => { await t.close(); });
  beforeEach(() => { disk.free = 12 * MiB; });

  it('refuses a PUT that would cross the reserve and leaves no file; a smaller one is stored', async () => {
    full(await putBytes(t, member, '/big.bin', Buffer.alloc(3 * MiB)));
    leftNothing(root, 'big.bin');
    expect((await putBytes(t, member, '/small.bin', Buffer.alloc(MiB))).statusCode).toBe(201);
    expect(existsSync(join(root, 'small.bin'))).toBe(true);
  });

  it('refuses a new version (PUT replace) that would cross the reserve and keeps the old content', async () => {
    expect((await putBytes(t, member, '/doc.bin', Buffer.alloc(KiB, 1))).statusCode).toBe(201);
    full(await putBytes(t, member, '/doc.bin', Buffer.alloc(3 * MiB, 2), 'replace'));
    const r = await as(t, member, 'GET', `/api/v1/sources/home/content?path=${encodeURIComponent('/doc.bin')}`);
    expect(r.rawPayload.equals(Buffer.alloc(KiB, 1))).toBe(true);
  });

  it('refuses a chunked PUT (no Content-Length) one byte over what is left and leaves no file', async () => {
    const r = await chunkedPut(t, '/api/v1/sources/home/content?path=%2Fchunked.bin&onCollision=fail',
      { cookie: member.cookie, 'x-csrf-token': member.csrf, origin: ORIGIN, 'content-type': 'application/octet-stream' }, 2 * MiB + 1);
    full(r);
    leftNothing(root, 'chunked.bin');
  });

  it('refuses a WebDAV PUT that would cross the reserve and leaves no file', async () => {
    const pw = await createAppPassword(t, member);
    const r = await chunkedPut(t, '/dav/dav.bin', { authorization: basic(pw) }, 2 * MiB + 1);
    expect(r.statusCode, r.body).toBe(507);
    leftNothing(root, 'dav.bin');
  });

  it('refuses a tus upload at creation, and counts every member\'s open uploads against the same disk', async () => {
    const big = await tusCreate(t, member, '/tus-big.bin', 3 * MiB);
    full(big);
    expect(t.db.prepare('SELECT count(*) FROM uploads').pluck().get()).toBe(0);
    // The admin's open upload holds 1.5 MiB of the 2 MiB left, so the member's 1 MiB no longer fits.
    const held = await tusCreate(t, admin, '/held.bin', 1.5 * MiB);
    expect(held.statusCode, held.body).toBe(201);
    full(await tusCreate(t, member, '/tus.bin', MiB));
    const heldId = uploadId(held.headers.location);
    expect((await as(t, admin, 'DELETE', `/api/v1/uploads/${heldId}`, undefined, { 'tus-resumable': '1.0.0' })).statusCode).toBe(204);
    const r = await tusCreate(t, member, '/tus.bin', MiB);
    expect(r.statusCode, r.body).toBe(201);
    expect((await as(t, member, 'DELETE', `/api/v1/uploads/${uploadId(r.headers.location)}`, undefined, { 'tus-resumable': '1.0.0' })).statusCode).toBe(204);
  });

  it('refuses a tus PATCH once the disk has filled up since the upload was created', async () => {
    const c = await tusCreate(t, member, '/later.bin', MiB);
    expect(c.statusCode, c.body).toBe(201);
    const id = uploadId(c.headers.location);
    disk.free = 10.5 * MiB; // something else took the space meanwhile: half a MiB is left
    const r = await as(t, member, 'PATCH', `/api/v1/uploads/${id}`, Buffer.alloc(MiB),
      { 'tus-resumable': '1.0.0', 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' });
    full(r);
    leftNothing(root, 'later.bin');
    expect((await as(t, member, 'DELETE', `/api/v1/uploads/${id}`, undefined, { 'tus-resumable': '1.0.0' })).statusCode).toBe(204);
  });

  it('refuses a copy within the home that would cross the reserve and stages nothing', async () => {
    writeFileSync(join(root, 'three.bin'), Buffer.alloc(3 * MiB, 3));
    full(await as(t, member, 'POST', '/api/v1/sources/home/copy', { from: '/three.bin', to: '/three copy.bin', onCollision: 'fail' }));
    expect(existsSync(join(root, 'three copy.bin'))).toBe(false);
    const staging = join(root, '.files', 'tmp');
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
  });

  it('fails a transfer item from a cloud into the home with STORAGE_FULL and places nothing', async () => {
    const r = await as(t, member, 'POST', '/api/v1/transfers', { mode: 'copy', from: 'conn:cloud1', to: 'home', dir: '/',
      items: [{ path: '/three.bin', onCollision: 'keep-both' }] });
    expect(r.statusCode, r.body).toBe(201);
    const job = await settled(t, member, r.json().id as string);
    expect(job).toMatchObject({ done: 0, failed: [{ path: '/three.bin', code: 'STORAGE_FULL' }] });
    expect(readdirSync(root).filter((n) => n.startsWith('three (')).length).toBe(0);
  });

  it('below the reserve, deleting, emptying the trash and revoking a link still work; restoring is refused', async () => {
    writeFileSync(join(root, 'restore-me.bin'), Buffer.alloc(3 * MiB, 4));
    writeFileSync(join(root, 'linked.bin'), Buffer.alloc(KiB, 5));
    const link = await as(t, member, 'POST', '/api/v1/links', { source: 'home', path: '/linked.bin' });
    expect(link.statusCode, link.body).toBe(201);
    disk.free = 4 * MiB; // the reserve is already eaten into
    expect((await as(t, member, 'POST', '/api/v1/sources/home/delete', { paths: ['/restore-me.bin'] })).statusCode).toBe(204);
    expect(existsSync(join(root, 'restore-me.bin'))).toBe(false);
    const trashId = ((await as(t, member, 'GET', '/api/v1/trash')).json().items as { id: string; name: string }[])
      .find((i) => i.name === 'restore-me.bin')!.id;
    disk.free = 12 * MiB;
    full(await as(t, member, 'POST', '/api/v1/trash/restore', { id: trashId, onCollision: 'fail' }));
    expect(existsSync(join(root, 'restore-me.bin'))).toBe(false);
    disk.free = 4 * MiB;
    expect((await as(t, member, 'DELETE', `/api/v1/links/${link.json().id as string}`)).statusCode).toBe(204);
    expect((await as(t, member, 'POST', '/api/v1/trash/empty')).statusCode).toBe(204);
    expect((await as(t, member, 'GET', '/api/v1/trash')).json().items).toEqual([]);
    // Even the smallest write is refused while below the reserve.
    full(await putBytes(t, member, '/tiny.bin', Buffer.alloc(1)));
  });

  it('skips new thumbnails below the reserve without failing the request; cached ones are still served', async () => {
    const jpeg = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 0, g: 112, b: 128 } } }).jpeg().toBuffer();
    expect((await putBytes(t, member, '/photo.jpg', jpeg)).statusCode).toBe(201);
    const thumb = (size: number) => as(t, member, 'GET', `/api/v1/sources/home/thumbnail?path=%2Fphoto.jpg&size=${size}`);
    expect((await thumb(128)).statusCode).toBe(200);
    disk.free = 9 * MiB;
    expect((await thumb(128)).statusCode).toBe(200);
    const skipped = await thumb(256);
    expect(skipped.statusCode, skipped.body).toBe(404);
    expect(skipped.json().code).toBe('NO_THUMBNAIL');
  });

  it('shows the admin the volume, the reserve and a warning from 90 % used; members get FORBIDDEN', async () => {
    const r = await as(t, admin, 'GET', '/api/v1/admin/disk');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ total: 100 * MiB, free: 12 * MiB, reserve: 10 * MiB, setting: '10MiB', warning: false });
    disk.free = 10 * MiB; // 90 % used
    expect((await as(t, admin, 'GET', '/api/v1/admin/disk')).json()).toMatchObject({ warning: true });
    expect((await as(t, member, 'GET', '/api/v1/admin/disk')).statusCode).toBe(403);
  });
});

describe('the reserve setting (#320)', () => {
  async function reserveOf(env: Record<string, string>, total: number, free: number) {
    const t = await startTestApp(env, undefined, undefined, { diskSpace: async () => ({ total, free }) });
    try {
      const admin = await signIn(t, 'testuser');
      const status = (await as(t, admin, 'GET', '/api/v1/admin/disk')).json() as { reserve: number; setting: string | null };
      // 1 GiB more than what is left beyond the reserve is refused at tus creation, 1 GiB less is accepted.
      const left = free - status.reserve;
      const over = await tusCreate(t, admin, '/over.bin', left + GiB);
      const under = await tusCreate(t, admin, '/under.bin', left - GiB);
      return { reserve: status.reserve, setting: status.setting, over: over.statusCode, under: under.statusCode };
    } finally { await t.close(); }
  }

  it('defaults to 5 GiB, or 5 % of a volume larger than 100 GiB', async () => {
    expect(await reserveOf({}, 50 * GiB, 8 * GiB)).toEqual({ reserve: 5 * GiB, setting: null, over: 507, under: 201 });
    expect(await reserveOf({}, 200 * GiB, 15 * GiB)).toEqual({ reserve: 10 * GiB, setting: null, over: 507, under: 201 });
  });

  it('takes FILES_DISK_RESERVE as bytes (10GiB) or a share of the volume (8%)', async () => {
    expect(await reserveOf({ FILES_DISK_RESERVE: '10GiB' }, 50 * GiB, 13 * GiB)).toEqual({ reserve: 10 * GiB, setting: '10GiB', over: 507, under: 201 });
    expect(await reserveOf({ FILES_DISK_RESERVE: '8%' }, 100 * GiB, 11 * GiB)).toEqual({ reserve: 8 * GiB, setting: '8%', over: 507, under: 201 });
  });

  const base = { FILES_PUBLIC_URL: 'https://files.example.com', FILES_DATA_DIR: join(tmpdir(), 'files-reserve-unused'),
    FILES_SESSION_SECRET: 's'.repeat(48), FILES_ENCRYPTION_KEY: 'k'.repeat(32), FILES_OIDC_ISSUER: 'https://idp.example.com',
    FILES_OIDC_CLIENT_ID: 'files', FILES_OIDC_CLIENT_SECRET: 'files-secret' };

  it.each(['garbage', '10', '0%', '0GiB', '100%', '150%', '-5GiB', '10 Gigs', '1.2.3GiB', ''])('refuses FILES_DISK_RESERVE=%j', (value) => {
    expect(() => loadConfig({ ...base, FILES_DISK_RESERVE: value })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, FILES_DISK_RESERVE: value })).toThrow(/FILES_DISK_RESERVE/);
  });

  it('accepts the units B, KiB, MiB, GiB, TiB, KB, MB, GB, TB and a decimal percentage', () => {
    for (const v of ['512B', '100KiB', '1.5MiB', '10GiB', '1TiB', '100KB', '700MB', '10GB', '2TB', '2.5%']) {
      expect(() => loadConfig({ ...base, FILES_DISK_RESERVE: v }), v).not.toThrow();
    }
  });

  it('the process exits 1 and names FILES_DISK_RESERVE when it is nonsense', () => {
    const mainTs = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    const r = spawnSync(process.execPath, ['--import', 'tsx', mainTs], {
      env: { PATH: process.env.PATH, NODE_ENV: 'production', ...base, FILES_DISK_RESERVE: 'lots' }, encoding: 'utf8', timeout: 20000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FILES_DISK_RESERVE');
  });
});
