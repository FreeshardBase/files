import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homeRoot } from '../src/paths.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { startFakeProvider, type FakeProvider } from './support/fakeProvider.ts';

// #154: a file that is overwritten keeps its previous content as a version under `<home>/.files/versions/`; versions
// are capped per file, follow moves, wait in the trash with their file and go with its permanent delete. Cloud sources
// list the provider's revisions and restore them through the provider's API.

type S = { cookie: string; csrf: string; id: string };
const ORIGIN = 'https://files.example.com';
type Version = { id: string; modified: string; size?: number; current?: boolean };

function du(dir: string): number {
  if (!existsSync(dir)) return 0;
  let sum = 0;
  for (const name of readdirSync(dir)) {
    const st = lstatSync(join(dir, name));
    if (st.isDirectory()) sum += du(join(dir, name)); else if (st.isFile()) sum += st.size;
  }
  return sum;
}

function client(t: () => TestApp) {
  const as = (s: S, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => t().app.inject({
    method, url, headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': s.csrf }), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  const q = (path: string) => `path=${encodeURIComponent(path)}`;
  return {
    as,
    put: (s: S, source: string, path: string, body: string | Buffer, onCollision = 'replace') => as(s, 'PUT',
      `/api/v1/sources/${source}/content?${q(path)}&onCollision=${onCollision}`, Buffer.from(body), { 'content-type': 'application/octet-stream' }),
    get: (s: S, source: string, path: string) => as(s, 'GET', `/api/v1/sources/${source}/content?${q(path)}`),
    versions: (s: S, source: string, path: string) => as(s, 'GET', `/api/v1/versions?source=${encodeURIComponent(source)}&${q(path)}`),
    versionContent: (s: S, source: string, path: string, id: string) =>
      as(s, 'GET', `/api/v1/versions/content?source=${encodeURIComponent(source)}&${q(path)}&id=${encodeURIComponent(id)}`),
    restore: (s: S, source: string, path: string, id: string) => as(s, 'POST', '/api/v1/versions/restore', { source, path, id }),
  };
}

async function session(t: TestApp, user: string): Promise<S> {
  const s = await login(t, user);
  return { ...s, id: (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id as string };
}

describe('local versions', () => {
  let t: TestApp; let a: S; let m: S; let root: string;
  const c = client(() => t);
  beforeAll(async () => {
    t = await startTestApp({ FILES_VERSIONS_MAX_COUNT: '3', FILES_VERSIONS_MAX_BYTES: '1000' });
    a = await session(t, 'testuser');
    m = await session(t, 'member');
    root = homeRoot(t.config.dataDir, a.id);
  });
  afterAll(() => t.close());

  const listOf = async (path: string, s: S = a): Promise<Version[]> => {
    const r = await c.versions(s, 'home', path);
    expect(r.statusCode, r.body).toBe(200);
    return r.json().versions as Version[];
  };
  const bytesOf = async (s: S, source: string, path: string, id: string) => {
    const r = await c.versionContent(s, source, path, id);
    expect(r.statusCode, r.body).toBe(200);
    return r.body;
  };
  const versionRows = () => t.db.prepare('SELECT count(*) FROM versions WHERE user_id = ?').pluck().get(a.id) as number;
  const versionsDir = () => join(root, '.files', 'versions');

  it('keeps the replaced content of every overwrite, and a restore brings back exact bytes and keeps the replaced one', async () => {
    expect((await c.put(a, 'home', '/notes.txt', 'one', 'fail')).statusCode).toBe(201);
    for (const v of ['two', 'three', 'four']) expect((await c.put(a, 'home', '/notes.txt', v)).statusCode).toBe(201);
    const vs = await listOf('/notes.txt');
    expect(vs).toHaveLength(3);
    expect(await Promise.all(vs.map((v) => bytesOf(a, 'home', '/notes.txt', v.id)))).toEqual(['one', 'two', 'three']); // oldest first
    expect(vs.map((v) => v.size)).toEqual([3, 3, 5]);

    const r = await c.restore(a, 'home', '/notes.txt', vs[0]!.id);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ path: '/notes.txt', size: 3 });
    expect((await c.get(a, 'home', '/notes.txt')).body).toBe('one');
    const after = await listOf('/notes.txt');
    expect(await Promise.all(after.map((v) => bytesOf(a, 'home', '/notes.txt', v.id)))).toEqual(['two', 'three', 'four']);
    expect(after.map((v) => v.id)).not.toContain(vs[0]!.id);
  });

  it('creates no version for a new file or "keep both"', async () => {
    await c.put(a, 'home', '/fresh.txt', 'x', 'fail');
    await c.put(a, 'home', '/fresh.txt', 'y', 'keep-both');
    expect(await listOf('/fresh.txt')).toEqual([]);
    expect(await listOf('/fresh (1).txt')).toEqual([]);
  });

  it('keeps a version when a tus upload replaces a file', async () => {
    await c.put(a, 'home', '/tus.txt', 'before', 'fail');
    const meta = (s: string) => Buffer.from(s).toString('base64');
    const created = await c.as(a, 'POST', '/api/v1/uploads', undefined, { 'tus-resumable': '1.0.0', 'upload-length': '5',
      'upload-metadata': `source ${meta('home')},path ${meta('/tus.txt')},onCollision ${meta('replace')}` });
    expect(created.statusCode, created.body).toBe(201);
    const url = new URL(String(created.headers.location), ORIGIN).pathname;
    const patched = await c.as(a, 'PATCH', url, Buffer.from('after'), { 'tus-resumable': '1.0.0', 'upload-offset': '0',
      'content-type': 'application/offset+octet-stream' });
    expect(patched.statusCode, patched.body).toBe(204);
    const vs = await listOf('/tus.txt');
    expect(vs).toHaveLength(1);
    expect(await bytesOf(a, 'home', '/tus.txt', vs[0]!.id)).toBe('before');
  });

  it('caps the versions of a file by count: the oldest goes, bytes included', async () => {
    await c.put(a, 'home', '/capped.txt', 'v1', 'fail');
    for (const v of ['v2', 'v3', 'v4', 'v5', 'v6']) await c.put(a, 'home', '/capped.txt', v);
    const vs = await listOf('/capped.txt');
    expect(await Promise.all(vs.map((v) => bytesOf(a, 'home', '/capped.txt', v.id)))).toEqual(['v3', 'v4', 'v5']);
    const all = t.db.prepare('SELECT id, size FROM versions WHERE user_id = ?').all(a.id) as { id: string; size: number }[];
    expect(readdirSync(versionsDir()).sort()).toEqual(all.map((v) => v.id).sort());
    expect(du(versionsDir())).toBe(all.reduce((s, v) => s + v.size, 0));
  });

  it('caps the versions of a file by size: the oldest go until the rest fit', async () => {
    await c.put(a, 'home', '/big.bin', 'a'.repeat(400), 'fail');
    await c.put(a, 'home', '/big.bin', 'b'.repeat(400));
    await c.put(a, 'home', '/big.bin', 'c'.repeat(400));
    await c.put(a, 'home', '/big.bin', 'd'.repeat(400)); // a, b, c would be 1200 > 1000
    const vs = await listOf('/big.bin');
    expect(await Promise.all(vs.map((v) => bytesOf(a, 'home', '/big.bin', v.id)))).toEqual(['b'.repeat(400), 'c'.repeat(400)]);
    const all = t.db.prepare('SELECT id, size FROM versions WHERE user_id = ?').all(a.id) as { id: string; size: number }[];
    expect(readdirSync(versionsDir()).sort()).toEqual(all.map((v) => v.id).sort());
    expect(du(versionsDir())).toBe(all.reduce((s, v) => s + v.size, 0));
  });

  it('versions follow a rename and a move of the folder above', async () => {
    await c.put(a, 'home', '/Move/a.txt', 'first', 'fail');
    await c.put(a, 'home', '/Move/a.txt', 'second');
    expect((await c.as(a, 'POST', '/api/v1/sources/home/move', { from: '/Move/a.txt', to: '/Move/b.txt', onCollision: 'fail' })).statusCode).toBe(200);
    expect(await listOf('/Move/a.txt').catch(() => [])).toEqual([]);
    const renamed = await listOf('/Move/b.txt');
    expect(renamed).toHaveLength(1);
    expect((await c.as(a, 'POST', '/api/v1/sources/home/move', { from: '/Move', to: '/Moved', onCollision: 'fail' })).statusCode).toBe(200);
    const moved = await listOf('/Moved/b.txt');
    expect(moved.map((v) => v.id)).toEqual(renamed.map((v) => v.id));
    expect(await bytesOf(a, 'home', '/Moved/b.txt', moved[0]!.id)).toBe('first');
  });

  it('versions wait in the trash with their file, come back with it, and go with its permanent delete', async () => {
    await c.put(a, 'home', '/Gone/doc.txt', 'old', 'fail');
    await c.put(a, 'home', '/Gone/doc.txt', 'new');
    const [v] = await listOf('/Gone/doc.txt');
    const before = versionRows();
    expect(existsSync(join(versionsDir(), v!.id))).toBe(true);

    expect((await c.as(a, 'POST', '/api/v1/sources/home/delete', { paths: ['/Gone'] })).statusCode).toBe(204);
    // Nothing of the trashed file is addressable as a live version, and another file at that path does not inherit them.
    await c.put(a, 'home', '/Gone/doc.txt', 'unrelated', 'fail');
    expect(await listOf('/Gone/doc.txt')).toEqual([]);
    await c.as(a, 'POST', '/api/v1/sources/home/delete', { paths: ['/Gone'] });

    const trash = (await c.as(a, 'GET', '/api/v1/trash')).json().items as { id: string; originalPath: string }[];
    const [second, first] = trash.filter((i) => i.originalPath === '/Gone');
    const r = await c.as(a, 'POST', '/api/v1/trash/restore', { id: first!.id, onCollision: 'fail' });
    expect(r.statusCode, r.body).toBe(200);
    const back = await listOf('/Gone/doc.txt');
    expect(back.map((x) => x.id)).toEqual([v!.id]);
    expect(await bytesOf(a, 'home', '/Gone/doc.txt', v!.id)).toBe('old');

    // Trash it again and purge it: the version's bytes and row go with it.
    await c.as(a, 'POST', '/api/v1/sources/home/delete', { paths: ['/Gone'] });
    const again = ((await c.as(a, 'GET', '/api/v1/trash')).json().items as { id: string; originalPath: string }[])
      .filter((i) => i.originalPath === '/Gone').map((i) => i.id);
    expect(again).toContain(second!.id);
    expect((await c.as(a, 'POST', '/api/v1/trash/delete', { ids: again })).statusCode).toBe(204);
    expect(existsSync(join(versionsDir(), v!.id))).toBe(false);
    expect(versionRows()).toBe(before - 1);
    const all = t.db.prepare('SELECT id, size FROM versions WHERE user_id = ?').all(a.id) as { id: string; size: number }[];
    expect(du(versionsDir())).toBe(all.reduce((s, x) => s + x.size, 0));
  });

  it('a replace by move sends the old file and its versions to the trash together', async () => {
    await c.put(a, 'home', '/R/target.txt', 't1', 'fail');
    await c.put(a, 'home', '/R/target.txt', 't2');
    const [v] = await listOf('/R/target.txt');
    await c.put(a, 'home', '/R/other.txt', 'o', 'fail');
    expect((await c.as(a, 'POST', '/api/v1/sources/home/move', { from: '/R/other.txt', to: '/R/target.txt', onCollision: 'replace' })).statusCode).toBe(200);
    expect(await listOf('/R/target.txt')).toEqual([]);
    expect(t.db.prepare('SELECT trash_id FROM versions WHERE id = ?').pluck().get(v!.id)).not.toBeNull();
  });

  it('a version id of another file or another member is NOT_FOUND, and the internal area stays unaddressable', async () => {
    await c.put(a, 'home', '/x.txt', '1', 'fail');
    await c.put(a, 'home', '/x.txt', '2');
    const [v] = await listOf('/x.txt');
    await c.put(a, 'home', '/y.txt', '1', 'fail');
    expect((await c.versionContent(a, 'home', '/y.txt', v!.id)).statusCode).toBe(404);
    expect((await c.restore(a, 'home', '/y.txt', v!.id)).statusCode).toBe(404);
    // The member's own home has no such file or version.
    expect((await c.versionContent(m, 'home', '/x.txt', v!.id)).statusCode).toBe(404);
    expect((await c.restore(m, 'home', '/x.txt', v!.id)).statusCode).toBe(404);
    expect((await c.get(a, 'home', `/.files/versions/${v!.id}`)).json().code).toBe('PATH_INVALID');
    expect((await c.versions(a, 'home', '/.files/versions')).json().code).toBe('PATH_INVALID');
    expect((await c.versionContent(a, 'home', '/x.txt', '../../etc/passwd')).statusCode).toBe(400);
  });

  it('a share with edit keeps versions of the owner\'s file; read can list and download but not restore', async () => {
    await c.put(a, 'home', '/Shared/s.txt', 'owner', 'fail');
    const share = async (path: string, access: string) => {
      const r = await c.as(a, 'POST', '/api/v1/shares', { source: 'home', path, grantee: m.id, access });
      expect(r.statusCode, r.body).toBe(201);
      return `share:${r.json().id as string}`;
    };
    const edit = await share('/Shared/s.txt', 'edit');
    expect((await c.put(m, edit, '/', 'member')).statusCode).toBe(201);
    const vs = (await c.versions(m, edit, '/')).json();
    expect(vs.restore).toBe(true);
    expect(vs.versions).toHaveLength(1);
    expect(await bytesOf(m, edit, '/', vs.versions[0].id)).toBe('owner');
    expect((await listOf('/Shared/s.txt')).map((v) => v.id)).toEqual([vs.versions[0].id]);

    await c.put(a, 'home', '/Shared/r.txt', 'r1', 'fail');
    await c.put(a, 'home', '/Shared/r.txt', 'r2');
    const read = await share('/Shared/r.txt', 'read');
    const rv = (await c.versions(m, read, '/')).json();
    expect(rv.restore).toBe(false);
    expect(await bytesOf(m, read, '/', rv.versions[0].id)).toBe('r1');
    expect((await c.restore(m, read, '/', rv.versions[0].id)).json().code).toBe('FORBIDDEN');
    expect((await c.get(a, 'home', '/Shared/r.txt')).body).toBe('r2');
  });

  it('counts versions in the quota', async () => {
    t.db.prepare('UPDATE users SET quota_bytes = ? WHERE id = ?').run(du(root) + 10, a.id);
    try {
      await c.put(a, 'home', '/q.txt', '12345678', 'fail'); // 8 of 10
      // Replacing keeps the 8 bytes as a version, so another 8 do not fit.
      expect((await c.put(a, 'home', '/q.txt', '87654321')).json().code).toBe('QUOTA_EXCEEDED');
    } finally {
      t.db.prepare('UPDATE users SET quota_bytes = NULL WHERE id = ?').run(a.id);
    }
  });
});

describe('cloud revisions', () => {
  let t: TestApp; let fake: FakeProvider; let a: S;
  const c = client(() => t);
  beforeAll(async () => {
    fake = await startFakeProvider();
    t = await startTestApp({}, undefined, undefined, { providers: [fake.dropboxProvider(), ...fake.graphProviders(), fake.driveProvider()] });
    a = await session(t, 'testuser');
  });
  afterAll(async () => { await t.close(); await fake.close(); });

  async function connect(provider: string): Promise<string> {
    const r = await c.as(a, 'POST', '/api/v1/connections/authorize', { provider });
    expect(r.statusCode, r.body).toBe(200);
    const back = await fake.consent(r.json().url as string);
    const cb = await c.as(a, 'GET', back.pathname + back.search);
    const found = /^\/conn:([0-9a-f]{32})$/.exec(String(cb.headers.location));
    expect(found, String(cb.headers.location)).not.toBeNull();
    return `conn:${found![1]!}`;
  }

  it('Dropbox: lists the revisions and restores one through files/restore', async () => {
    const source = await connect('dropbox');
    fake.dropbox.put('/rev.txt', 'first');
    expect((await c.put(a, source, '/rev.txt', 'second')).statusCode).toBe(201);
    const r = await c.versions(a, source, '/rev.txt');
    expect(r.statusCode, r.body).toBe(200);
    const vs = r.json().versions as Version[];
    expect(vs).toHaveLength(2);
    expect(vs.map((v) => v.current ?? false)).toEqual([false, true]);
    expect(r.json()).toMatchObject({ restore: true, download: false });
    const n = fake.requests.length;
    const res = await c.restore(a, source, '/rev.txt', vs[0]!.id);
    expect(res.statusCode, res.body).toBe(200);
    const call = fake.requests.slice(n).find((x) => x.path.endsWith('/2/files/restore'));
    expect(call?.body).toMatchObject({ path: '/rev.txt', rev: vs[0]!.id });
    expect(fake.dropbox.bytes('/rev.txt').toString()).toBe('first');
    expect((await c.versions(a, source, '/rev.txt')).json().versions).toHaveLength(3);
  });

  it('OneDrive: lists the versions and restores one through restoreVersion', async () => {
    const source = await connect('onedrive');
    fake.graph.put('/ver.txt', 'first');
    expect((await c.put(a, source, '/ver.txt', 'second')).statusCode).toBe(201);
    const vs = (await c.versions(a, source, '/ver.txt')).json().versions as Version[];
    expect(vs).toHaveLength(2);
    const n = fake.requests.length;
    const res = await c.restore(a, source, '/ver.txt', vs[0]!.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(fake.requests.slice(n).some((x) => x.method === 'POST'
      && x.path.endsWith(`/versions/${encodeURIComponent(vs[0]!.id)}/restoreVersion`))).toBe(true);
    expect(fake.graph.bytes('/ver.txt').toString()).toBe('first');
  });

  it('Google Drive: lists revisions, restore is not offered', async () => {
    const source = await connect('google-drive');
    fake.drive.put('/drive.txt', 'first');
    expect((await c.put(a, source, '/drive.txt', 'second')).statusCode).toBe(201);
    const r = (await c.versions(a, source, '/drive.txt')).json();
    expect(r.versions).toHaveLength(2);
    expect(r.restore).toBe(false);
    expect((await c.restore(a, source, '/drive.txt', r.versions[0].id)).json().code).toBe('NOT_SUPPORTED');
  });
});
