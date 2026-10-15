import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeRoot } from '../src/paths.ts';
import type { ConnectedBackend } from '../src/storage/backend.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { startFakeProvider, type FakeProvider } from './support/fakeProvider.ts';
import { MemBackend } from './support/memBackend.ts';

// #156: the storage overview and per-member quotas. The admin (role from the OIDC claim) sets a member's shard quota;
// every way bytes land in a home (tus creation, PUT, copy, trash restore, transfer and migration items) is refused with
// QUOTA_EXCEEDED before it is accepted. Members see their usage per source and their largest folders.

type S = { cookie: string; csrf: string; id: string };
type Job = { id: string; status: string; done: number; failed: { path: string; code: string }[] };
const ORIGIN = 'https://files.example.com';
const MB = 1_000_000;

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
const putBytes = (t: TestApp, s: S, path: string, bytes: Buffer) => as(t, s, 'PUT',
  `/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=fail`, bytes, { 'content-type': 'application/octet-stream' });
const quotaOf = (t: TestApp, id: string) => t.db.prepare('SELECT quota_bytes FROM users WHERE id = ?').pluck().get(id);
async function settled(t: TestApp, s: S, id: string): Promise<Job> {
  const end = Date.now() + 10_000;
  for (;;) {
    const j = (await as(t, s, 'GET', `/api/v1/transfers/${id}`)).json() as Job;
    if (j.status !== 'running') return j;
    if (Date.now() > end) throw new Error(`job ${id} did not settle`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('quota enforcement (#156)', () => {
  let t: TestApp; let admin: S; let member: S; let cloud: MemBackend; let root: string; let trashId: string;
  const conns = new Map<string, ConnectedBackend[]>();

  beforeAll(async () => {
    t = await startTestApp({}, undefined, undefined, { connections: async (u) => conns.get(u.id) ?? [] });
    admin = await signIn(t, 'testuser');
    member = await signIn(t, 'member');
    cloud = new MemBackend();
    cloud.put('/two.bin', Buffer.alloc(2 * MB, 7)).put('/Album/two.bin', Buffer.alloc(2 * MB, 8));
    conns.set(member.id, [{ id: 'cloud1', backend: cloud }]);
    // 9 MB used: 5 MB of files, a 2 MB file to copy, and a 2 MB file in the trash.
    root = homeRoot(t.config.dataDir, member.id);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'fill.bin'), Buffer.alloc(5 * MB));
    writeFileSync(join(root, 'two.bin'), Buffer.alloc(2 * MB, 1));
    writeFileSync(join(root, 'gone.bin'), Buffer.alloc(2 * MB, 2));
    expect((await as(t, member, 'POST', '/api/v1/sources/home/delete', { paths: ['/gone.bin'] })).statusCode).toBe(204);
    trashId = (await as(t, member, 'GET', '/api/v1/trash')).json().items[0].id as string;
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => {
    const r = await as(t, admin, 'PUT', `/api/v1/admin/members/${member.id}/quota`, { quotaBytes: 10 * MB });
    expect(r.statusCode, r.body).toBe(200);
  });

  it('reports 9 MB used of a 10 MB quota, the trash included', async () => {
    const r = await as(t, member, 'GET', '/api/v1/storage');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().home).toMatchObject({ quota: 10 * MB, usage: { total: 9 * MB, files: 7 * MB, trash: 2 * MB, versions: 0 } });
  });

  it('refuses a 2 MB tus upload at creation', async () => {
    const r = await as(t, member, 'POST', '/api/v1/uploads', undefined, { 'tus-resumable': '1.0.0', 'upload-length': String(2 * MB),
      'upload-metadata': `source ${b64('home')},path ${b64('/tus.bin')}` });
    expect(r.statusCode).toBe(507);
    expect(r.json().code).toBe('QUOTA_EXCEEDED');
    expect(t.db.prepare('SELECT count(*) FROM uploads WHERE user_id = ?').pluck().get(member.id)).toBe(0);
  });

  it('refuses a 2 MB PUT', async () => {
    const r = await putBytes(t, member, '/put.bin', Buffer.alloc(2 * MB));
    expect(r.json().code).toBe('QUOTA_EXCEEDED');
    expect(existsSync(join(root, 'put.bin'))).toBe(false);
  });

  it('refuses copying a 2 MB file, and copies it once the quota is removed', async () => {
    const r = await as(t, member, 'POST', '/api/v1/sources/home/copy', { from: '/two.bin', to: '/two copy.bin', onCollision: 'fail' });
    expect(r.statusCode).toBe(507);
    expect(r.json().code).toBe('QUOTA_EXCEEDED');
    expect(existsSync(join(root, 'two copy.bin'))).toBe(false);
    const staging = join(root, '.files', 'tmp');
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
    expect((await as(t, admin, 'PUT', `/api/v1/admin/members/${member.id}/quota`, { quotaBytes: null })).statusCode).toBe(200);
    expect((await as(t, member, 'POST', '/api/v1/sources/home/copy', { from: '/two.bin', to: '/two copy.bin', onCollision: 'fail' })).statusCode).toBe(201);
    expect((await as(t, member, 'POST', '/api/v1/sources/home/delete', { paths: ['/two copy.bin'] })).statusCode).toBe(204);
    const copied = ((await as(t, member, 'GET', '/api/v1/trash')).json().items as { id: string; name: string }[]).find((i) => i.name === 'two copy.bin')!;
    expect((await as(t, member, 'POST', '/api/v1/trash/delete', { ids: [copied.id] })).statusCode).toBe(204);
  });

  it('refuses restoring a 2 MB file from the trash, and restores it once the quota is removed', async () => {
    const r = await as(t, member, 'POST', '/api/v1/trash/restore', { id: trashId, onCollision: 'fail' });
    expect(r.statusCode).toBe(507);
    expect(r.json().code).toBe('QUOTA_EXCEEDED');
    expect(existsSync(join(root, 'gone.bin'))).toBe(false);
    expect((await as(t, member, 'GET', '/api/v1/trash')).json().items.map((i: { id: string }) => i.id)).toEqual([trashId]);
    expect((await as(t, admin, 'PUT', `/api/v1/admin/members/${member.id}/quota`, { quotaBytes: null })).statusCode).toBe(200);
    expect((await as(t, member, 'POST', '/api/v1/trash/restore', { id: trashId, onCollision: 'fail' })).statusCode).toBe(200);
    expect((await as(t, member, 'POST', '/api/v1/sources/home/delete', { paths: ['/gone.bin'] })).statusCode).toBe(204);
    trashId = (await as(t, member, 'GET', '/api/v1/trash')).json().items[0].id as string;
  });

  it('fails a 2 MB transfer item into the home with QUOTA_EXCEEDED and places nothing', async () => {
    const r = await as(t, member, 'POST', '/api/v1/transfers', { mode: 'copy', from: 'conn:cloud1', to: 'home', dir: '/',
      items: [{ path: '/two.bin', onCollision: 'keep-both' }] });
    expect(r.statusCode, r.body).toBe(201);
    const job = await settled(t, member, r.json().id as string);
    expect(job).toMatchObject({ status: 'completed_with_errors', done: 0, failed: [{ path: '/two.bin', code: 'QUOTA_EXCEEDED' }] });
    expect(readdirSync(root).sort()).toEqual(['.files', 'fill.bin', 'two.bin']);
  });

  it('fails a 2 MB migration item with QUOTA_EXCEEDED', async () => {
    const r = await as(t, member, 'POST', '/api/v1/migrations', { from: 'conn:cloud1', path: '/Album', dir: '/', name: 'Migrated' });
    expect(r.statusCode, r.body).toBe(201);
    const job = await settled(t, member, r.json().id as string);
    expect(job.failed).toEqual([{ path: '/Album/two.bin', code: 'QUOTA_EXCEEDED' }]);
    expect(existsSync(join(root, 'Migrated', 'two.bin'))).toBe(false);
  });
});

describe('admin only (#156)', () => {
  let t: TestApp; let admin: S; let member: S;
  beforeAll(async () => {
    t = await startTestApp();
    admin = await signIn(t, 'testuser');
    member = await signIn(t, 'member');
  });
  afterAll(async () => { await t.close(); });

  it('a member cannot read other members\' usage (403)', async () => {
    const r = await as(t, member, 'GET', '/api/v1/admin/members');
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('FORBIDDEN');
  });

  it('a member cannot set a quota, not even their own (403), and nothing changes', async () => {
    for (const id of [admin.id, member.id]) {
      const r = await as(t, member, 'PUT', `/api/v1/admin/members/${id}/quota`, { quotaBytes: 5 });
      expect(r.statusCode).toBe(403);
      expect(r.json().code).toBe('FORBIDDEN');
      expect(quotaOf(t, id)).toBeNull();
    }
  });

  it('the admin lists every member with usage and quota, sets and removes a quota, and the member sees it', async () => {
    expect((await putBytes(t, member, '/m.txt', Buffer.from('twelve bytes'))).statusCode).toBe(201);
    const set = await as(t, admin, 'PUT', `/api/v1/admin/members/${member.id}/quota`, { quotaBytes: 50 * MB });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({ id: member.id, quota: 50 * MB, used: 12 });
    expect(quotaOf(t, member.id)).toBe(50 * MB);
    const list = (await as(t, admin, 'GET', '/api/v1/admin/members')).json().items as { id: string }[];
    expect(list).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: admin.id, displayName: 'Test User', role: 'admin', quota: null }),
      expect.objectContaining({ id: member.id, displayName: 'Test Member', role: 'member', quota: 50 * MB, used: 12 }),
    ]));
    expect(list).toHaveLength(2);
    expect((await as(t, member, 'GET', '/api/v1/storage')).json().home.quota).toBe(50 * MB);
    expect((await as(t, admin, 'PUT', `/api/v1/admin/members/${member.id}/quota`, { quotaBytes: null })).statusCode).toBe(200);
    expect((await as(t, member, 'GET', '/api/v1/storage')).json().home.quota).toBeNull();
  });

  it('refuses a negative or fractional quota and an unknown member', async () => {
    for (const quotaBytes of [-1, 1.5, '10']) {
      expect((await as(t, admin, 'PUT', `/api/v1/admin/members/${member.id}/quota`, { quotaBytes })).statusCode).toBe(400);
    }
    const unknown = await as(t, admin, 'PUT', '/api/v1/admin/members/00000000-0000-4000-8000-000000000000/quota', { quotaBytes: 1 });
    expect(unknown.statusCode).toBe(404);
    expect(quotaOf(t, member.id)).toBeNull();
  });

  it('the role comes from the claim: without the claim config the IdP admin is a member and gets 403', async () => {
    const u = await startTestApp({ FILES_OIDC_ROLE_CLAIM: undefined, FILES_OIDC_ADMIN_VALUE: undefined });
    try {
      const s = await signIn(u, 'testuser');
      expect((await as(u, s, 'GET', '/api/v1/admin/members')).statusCode).toBe(403);
    } finally { await u.close(); }
  });
});

describe('overview (#156)', () => {
  let t: TestApp; let fake: FakeProvider; let a: S; let b: S;
  beforeAll(async () => {
    fake = await startFakeProvider();
    t = await startTestApp({}, undefined, undefined, { providers: [fake.provider()] });
    a = await signIn(t, 'testuser');
    b = await signIn(t, 'member');
  });
  afterAll(async () => { await t.close(); await fake.close(); });

  it('shows the provider quota per connection, only to its owner, and a failing provider as its error code', async () => {
    const auth = await as(t, a, 'POST', '/api/v1/connections/authorize', { provider: 'fake' });
    const back = await fake.consent(auth.json().url as string);
    const source = /^\/(conn:[0-9a-f]{32})$/.exec(String((await as(t, a, 'GET', back.pathname + back.search)).headers.location))![1]!;
    fake.quota = { used: 3 * MB, total: 15_000 * MB };
    const r = await as(t, a, 'GET', '/api/v1/storage');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().connections).toEqual([{ source, quota: { used: 3 * MB, total: 15_000 * MB } }]);
    expect((await as(t, b, 'GET', '/api/v1/storage')).json().connections).toEqual([]);
    fake.quota = { used: 4 * MB };
    expect((await as(t, a, 'GET', '/api/v1/storage')).json().connections).toEqual([{ source, quota: { used: 4 * MB } }]);
    fake.revokeRefreshTokens();
    fake.expireAccessTokens();
    const failing = await as(t, a, 'GET', '/api/v1/storage');
    expect(failing.statusCode).toBe(200);
    expect(failing.json().connections).toEqual([{ source, error: { code: 'CONNECTION_REAUTH' } }]);
    expect(failing.json().home.usage).toBeDefined();
  });

  it('lists the largest folders of the home, biggest first, without the trash', async () => {
    for (const [p, n] of [['/Big/a.bin', 3000], ['/Big/Sub/b.bin', 2000], ['/Small/c.bin', 10], ['/Bin/d.bin', 9000], ['/top.bin', 50_000]] as const) {
      expect((await putBytes(t, b, p, Buffer.alloc(n))).statusCode).toBe(201);
    }
    expect((await as(t, b, 'POST', '/api/v1/sources/home/delete', { paths: ['/Bin'] })).statusCode).toBe(204);
    const home = (await as(t, b, 'GET', '/api/v1/storage')).json().home;
    expect(home.largest).toEqual([{ path: '/Big', size: 5000 }, { path: '/Big/Sub', size: 2000 }, { path: '/Small', size: 10 }]);
    expect(home.usage).toMatchObject({ files: 55_010, trash: 9000, total: 64_010 });
    expect(home.quota).toBeNull();
  });
});
