import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homeRoot } from '../src/paths.ts';
import type { ConnectedBackend } from '../src/storage/backend.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { startFakeProvider, type FakeProvider } from './support/fakeProvider.ts';
import { MemBackend } from './support/memBackend.ts';

// #216: the duplicate finder. Files are grouped by size first, then by hash within one algorithm (the home's SHA-256,
// a cloud's own listed hash); nothing is deleted by a scan, a delete re-checks size and hash right before it runs and
// goes to the trash, and a scan can be cancelled.

type S = { cookie: string; csrf: string; id: string };
type Copy = { source: string; path: string; name: string; modified?: string };
type Group = { id: string; size: number; algorithm: string; copies: Copy[] };
type Scan = { status: string; files: number; candidates: number; hashed: number; unhashed: number; complete: boolean;
  failed: { source: string; code: string }[]; groups: Group[] };
type Results = { results: { source: string; path: string; trashed: boolean; code?: string }[] };
const ORIGIN = 'https://files.example.com';

const as = (t: TestApp, s: S, method: string, url: string, payload?: unknown) => t.app.inject({
  method: method as 'GET', url,
  headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': s.csrf }) },
  ...(payload !== undefined ? { payload: payload as object } : {}),
});
async function signIn(t: TestApp, user: string): Promise<S> {
  const s = await login(t, user);
  return { ...s, id: (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id as string };
}
async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const state = async (t: TestApp, s: S) => (await as(t, s, 'GET', '/api/v1/duplicates')).json() as Scan;
async function scan(t: TestApp, s: S, sources: string[] = ['home']): Promise<Scan> {
  const r = await as(t, s, 'POST', '/api/v1/duplicates/scan', { sources });
  expect(r.statusCode, r.body).toBe(202);
  return until(() => state(t, s), (v) => v.status !== 'running', 'the scan');
}
// The groups whose copies lie in `dir` of `source` (other tests' files share the home).
const within = (v: Scan, dir: string, source = 'home') => v.groups.filter((g) => g.copies.every((c) => c.source === source && c.path.startsWith(`${dir}/`)));
const paths = (g: Group) => g.copies.map((c) => c.path).sort();
const trash = (t: TestApp, s: S, items: { source: string; path: string }[]) => as(t, s, 'POST', '/api/v1/duplicates/trash', { items });
let n = 0;

describe('duplicate finder', () => {
  let t: TestApp; let a: S; let fake: FakeProvider;
  const mems: ConnectedBackend[] = [];
  const home = () => homeRoot(t.config.dataDir, a.id);
  // A fresh home folder with `files` (relative path → bytes).
  const folder = (files: Record<string, Buffer | string>) => {
    const dir = `/dups-${++n}`;
    for (const [rel, data] of Object.entries(files)) {
      mkdirSync(join(home(), dir, rel, '..'), { recursive: true });
      writeFileSync(join(home(), dir, rel), data);
    }
    return dir;
  };
  async function connect(provider: string): Promise<string> {
    const r = await as(t, a, 'POST', '/api/v1/connections/authorize', { provider });
    expect(r.statusCode, r.body).toBe(200);
    const back = await fake.consent(r.json().url as string);
    const cb = await as(t, a, 'GET', back.pathname + back.search);
    const m = /^\/(conn:[0-9a-f]{32})$/.exec(String(cb.headers.location));
    expect(m, String(cb.headers.location)).not.toBeNull();
    return m![1]!;
  }

  beforeAll(async () => {
    fake = await startFakeProvider({ pageSize: 2 });
    t = await startTestApp({}, undefined, undefined, {
      providers: [fake.driveProvider(), fake.dropboxProvider(), ...fake.graphProviders()],
      connections: async (u) => [...await t.app.deps.cloud.backends(u.id), ...(u.id === a.id ? mems : [])] });
    a = await signIn(t, 'testuser');
  });
  afterAll(async () => { await t.close(); await fake.close(); });

  it('groups identical files and never files of equal size with different content', async () => {
    const x = randomBytes(5000); const y = randomBytes(5000);
    const dir = folder({ 'a.bin': x, 'deep/er/b.bin': x, 'c.bin': y, 'd.bin': Buffer.concat([x, Buffer.from('!')]),
      'e.txt': '', 'f.txt': '', 'g.bin': randomBytes(7000) });
    const v = await scan(t, a);
    expect(v).toMatchObject({ status: 'completed', complete: true, failed: [] });
    const groups = within(v, dir);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ size: 5000, algorithm: 'sha256' });
    expect(paths(groups[0]!)).toEqual([`${dir}/a.bin`, `${dir}/deep/er/b.bin`]);
    // Files whose size no other file has were never read: no hash was computed for them.
    const hashed = t.db.prepare('SELECT path, sha256 FROM content_hashes WHERE user_id = ? AND substr(path, 1, ?) = ?')
      .all(a.id, dir.length + 1, `${dir}/`) as { path: string; sha256: string }[];
    expect(hashed.map((h) => h.path).sort()).toEqual([`${dir}/a.bin`, `${dir}/c.bin`, `${dir}/deep/er/b.bin`]);
    expect(hashed.find((h) => h.path === `${dir}/c.bin`)!.sha256).toBe(createHash('sha256').update(y).digest('hex'));
  });

  it('caches a home hash with size and mtime; the cached row follows a move and goes with a delete', async () => {
    const x = randomBytes(3000);
    const dir = folder({ 'one.bin': x, 'two.bin': x });
    await scan(t, a);
    const row = (p: string) => t.db.prepare('SELECT sha256 FROM content_hashes WHERE user_id = ? AND path = ?').get(a.id, p) as { sha256: string } | undefined;
    expect(row(`${dir}/one.bin`)?.sha256).toBe(createHash('sha256').update(x).digest('hex'));
    // Changed outside the app with size and mtime kept: the scan trusts its cache (the file is read only when they differ).
    const st = statSync(join(home(), dir, 'two.bin'));
    writeFileSync(join(home(), dir, 'two.bin'), randomBytes(3000));
    utimesSync(join(home(), dir, 'two.bin'), st.atime, st.mtime);
    expect(within(await scan(t, a), dir)).toHaveLength(1);
    const mv = await as(t, a, 'POST', '/api/v1/sources/home/move', { from: `${dir}/one.bin`, to: `${dir}/moved.bin`, onCollision: 'fail' });
    expect(mv.statusCode, mv.body).toBe(200);
    expect(row(`${dir}/one.bin`)).toBeUndefined();
    expect(row(`${dir}/moved.bin`)?.sha256).toBe(createHash('sha256').update(x).digest('hex'));
    expect((await as(t, a, 'POST', '/api/v1/sources/home/delete', { paths: [`${dir}/moved.bin`] })).statusCode).toBe(204);
    expect(row(`${dir}/moved.bin`)).toBeUndefined();
  });

  it('moves a picked copy to the trash, where it can be restored, and never takes the last copy', async () => {
    const x = randomBytes(4000);
    const dir = folder({ 'keep.bin': x, 'copy.bin': x, 'copy 2.bin': x });
    const v = await scan(t, a);
    expect(paths(within(v, dir)[0]!)).toEqual([`${dir}/copy 2.bin`, `${dir}/copy.bin`, `${dir}/keep.bin`]);
    const all = within(v, dir)[0]!.copies.map((c) => ({ source: c.source, path: c.path }));
    const last = await trash(t, a, all);
    expect(last.statusCode).toBe(409);
    expect(last.json().code).toBe('DUPLICATE_LAST_COPY');
    expect(['keep.bin', 'copy.bin', 'copy 2.bin'].every((f) => existsSync(join(home(), dir, f)))).toBe(true);
    expect((await trash(t, a, [{ source: 'home', path: `${dir}/elsewhere.bin` }])).statusCode).toBe(404);

    const r = await trash(t, a, [{ source: 'home', path: `${dir}/copy.bin` }, { source: 'home', path: `${dir}/copy 2.bin` }]);
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as Results).results).toEqual([
      { source: 'home', path: `${dir}/copy.bin`, trashed: true }, { source: 'home', path: `${dir}/copy 2.bin`, trashed: true }]);
    expect(existsSync(join(home(), dir, 'copy.bin'))).toBe(false);
    expect(existsSync(join(home(), dir, 'keep.bin'))).toBe(true);
    // The group is resolved in the scan's result.
    expect(within(await state(t, a), dir)).toHaveLength(0);
    const items = ((await as(t, a, 'GET', '/api/v1/trash')).json() as { items: { id: string; originalPath: string }[] }).items;
    const trashed = items.find((i) => i.originalPath === `${dir}/copy.bin`)!;
    expect(trashed).toBeDefined();
    expect((await as(t, a, 'POST', '/api/v1/trash/restore', { id: trashed.id, onCollision: 'fail' })).statusCode).toBe(200);
    expect(readFileSync(join(home(), dir, 'copy.bin')).equals(x)).toBe(true);
  });

  it('does not delete a file changed after the scan, nor a copy whose kept copy changed', async () => {
    const x = randomBytes(2000);
    const dir = folder({ 'a.bin': x, 'b.bin': x, 'c.bin': x, 'd.bin': x });
    await scan(t, a);
    // Same size, other bytes, and the old mtime: only hashing the file again tells.
    const st = statSync(join(home(), dir, 'b.bin'));
    writeFileSync(join(home(), dir, 'b.bin'), randomBytes(2000));
    utimesSync(join(home(), dir, 'b.bin'), st.atime, st.mtime);
    const r = await trash(t, a, [{ source: 'home', path: `${dir}/b.bin` }]);
    expect((r.json() as Results).results).toEqual([{ source: 'home', path: `${dir}/b.bin`, trashed: false, code: 'DUPLICATE_CHANGED' }]);
    expect(existsSync(join(home(), dir, 'b.bin'))).toBe(true);
    const inTrash = ((await as(t, a, 'GET', '/api/v1/trash')).json() as { items: { originalPath: string }[] }).items.map((i) => i.originalPath);
    expect(inTrash).not.toContain(`${dir}/b.bin`);

    // Every copy that would stay has changed: deleting the picked ones could lose the content, so they stay too. (A new
    // mtime makes the next scan read "b.bin" again instead of trusting its cached hash.)
    utimesSync(join(home(), dir, 'b.bin'), new Date(), new Date());
    const v = await scan(t, a);
    const g = within(v, dir)[0]!;
    expect(paths(g)).toEqual([`${dir}/a.bin`, `${dir}/c.bin`, `${dir}/d.bin`]);
    for (const f of ['a.bin', 'c.bin']) writeFileSync(join(home(), dir, f), randomBytes(2000));
    const kept = await trash(t, a, [{ source: 'home', path: `${dir}/d.bin` }]);
    expect((kept.json() as Results).results[0]).toMatchObject({ trashed: false, code: 'DUPLICATE_CHANGED' });
    expect(existsSync(join(home(), dir, 'd.bin'))).toBe(true);
  });

  it('compares a cloud\'s own listed hash only within its algorithm, never guesses one, and re-checks it before a delete', async () => {
    const m = new MemBackend({ listHash: true });
    mems.push({ id: 'mem', backend: m });
    const x = randomBytes(1500);
    m.put('/A/p.bin', x).put('/B/p.bin', x).put('/C/p.bin', x).put('/D/q.bin', randomBytes(1500));
    m.noHash.add('/C/p.bin');
    const dir = folder({ 'same-as-cloud.bin': x });
    const v = await scan(t, a, ['home', 'conn:mem']);
    expect(v.status).toBe('completed');
    const cloud = within(v, '', 'conn:mem');
    expect(cloud).toHaveLength(1);
    expect(cloud[0]).toMatchObject({ algorithm: 'md5' });
    expect(paths(cloud[0]!)).toEqual(['/A/p.bin', '/B/p.bin']);
    // The file without a listed hash is counted, not grouped; the home's equal file has another algorithm.
    expect(v.unhashed).toBe(1);
    expect(v.groups.some((g) => g.copies.some((c) => c.path === `${dir}/same-as-cloud.bin`))).toBe(false);

    m.put('/B/p.bin', randomBytes(1500)); // changed at the provider after the scan
    const changed = await trash(t, a, [{ source: 'conn:mem', path: '/B/p.bin' }]);
    expect((changed.json() as Results).results[0]).toMatchObject({ trashed: false, code: 'DUPLICATE_CHANGED' });
    expect(m.deleted).toEqual([]);
    // Scanned again, "/A/p.bin" has no listed twin left ("/C/p.bin" lists no hash).
    expect(within(await scan(t, a, ['conn:mem']), '', 'conn:mem')).toHaveLength(0);
    m.put('/B/p.bin', x);
    const v3 = await scan(t, a, ['conn:mem']);
    expect(paths(within(v3, '', 'conn:mem')[0]!)).toEqual(['/A/p.bin', '/B/p.bin']);
    const ok = await trash(t, a, [{ source: 'conn:mem', path: '/B/p.bin' }]);
    expect((ok.json() as Results).results[0]).toMatchObject({ trashed: true });
    expect(m.deleted).toEqual(['/B/p.bin']);
  });

  it('finds duplicates by Google Drive\'s MD5, Dropbox\'s content hash and OneDrive\'s SHA-1', async () => {
    const x = randomBytes(2500); const y = randomBytes(2500);
    fake.drive.put('/Dup/one.bin', x); fake.drive.put('/Dup/two.bin', x); fake.drive.put('/Dup/other.bin', y);
    fake.dropbox.put('/Dup/one.bin', x); fake.dropbox.put('/Dup/sub/two.bin', x); fake.dropbox.put('/Dup/other.bin', y);
    fake.graph.put('/Dup/one.bin', x); fake.graph.put('/Dup/two.bin', x); fake.graph.put('/Dup/other.bin', y);
    for (const [provider, algorithm, two] of [['google-drive', 'md5', '/Dup/two.bin'], ['dropbox', 'dropbox', '/Dup/sub/two.bin'],
      ['onedrive', 'sha1', '/Dup/two.bin']] as const) {
      const conn = await connect(provider);
      const v = await scan(t, a, [conn]);
      expect(v.failed, provider).toEqual([]);
      const groups = within(v, '/Dup', conn);
      expect(groups, provider).toHaveLength(1);
      expect(groups[0]!.algorithm).toBe(algorithm);
      expect(paths(groups[0]!).map((p) => p.toLowerCase())).toEqual(['/dup/one.bin', two.toLowerCase()]);
    }
  });

  it('scans only the member\'s own storage', async () => {
    expect((await as(t, a, 'POST', '/api/v1/duplicates/scan', { sources: ['share:abc'] })).statusCode).toBe(400);
    expect((await as(t, a, 'POST', '/api/v1/duplicates/scan', { sources: ['conn:nope'] })).statusCode).toBe(404);
  });
});

describe('duplicate scan budget and cancel', () => {
  let t: TestApp; let a: S;
  beforeAll(async () => {
    // 64 KiB per second: hashing the files below would take about a minute.
    t = await startTestApp({ FILES_DUPLICATE_SCAN_BYTES_PER_SECOND: String(64 * 1024) });
    a = await signIn(t, 'testuser');
  });
  afterAll(async () => { await t.close(); });

  it('reads within its byte budget, and cancelling stops the scan', async () => {
    const dir = join(homeRoot(t.config.dataDir, a.id), 'big');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 8; i++) writeFileSync(join(dir, `f${i}.bin`), randomBytes(512 * 1024));
    const started = await as(t, a, 'POST', '/api/v1/duplicates/scan', { sources: ['home'] });
    expect(started.statusCode, started.body).toBe(202);
    expect((await as(t, a, 'POST', '/api/v1/duplicates/scan', { sources: ['home'] })).json().code).toBe('SCAN_RUNNING');
    const running = await until(() => state(t, a), (v) => v.candidates === 8, 'the candidates');
    expect(running.status).toBe('running');
    // A second later the budget has allowed about 64 KiB more: not a single file is done.
    await new Promise((r) => setTimeout(r, 1000));
    expect((await state(t, a)).hashed).toBe(0);
    const before = Date.now();
    const c = await as(t, a, 'POST', '/api/v1/duplicates/cancel');
    expect(c.statusCode).toBe(200);
    expect(c.json()).toMatchObject({ status: 'cancelled', groups: [] });
    expect(Date.now() - before).toBeLessThan(2000);
    const rows = () => t.db.prepare('SELECT count(*) FROM content_hashes WHERE user_id = ?').pluck().get(a.id) as number;
    const count = rows();
    await new Promise((r) => setTimeout(r, 1500));
    expect(rows()).toBe(count);
    expect((await state(t, a)).status).toBe('cancelled');
    expect(count).toBe(0);
  });
});
