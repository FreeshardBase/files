import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homeRoot } from '../src/paths.ts';
import type { ConnectedBackend } from '../src/storage/backend.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { startFakeProvider, type FakeProvider } from './support/fakeProvider.ts';
import { MemBackend } from './support/memBackend.ts';

// #153: a member migrates a cloud folder or a whole account onto the shard as one transfer job (#152), gets a summary
// with every failure and its export, and can then delete the verified originals from the cloud, only after an explicit
// confirmation and only for files that are still verified.

type S = { cookie: string; csrf: string; id: string };
type Job = { id: string; kind: string; origin: string | null; status: string; total: number; done: number;
  failed: { path: string; code: string }[]; cancelled: number; verifiedFiles: number; files: number; listing: boolean };
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
const jobOf = async (t: TestApp, s: S, id: string) => {
  const r = await as(t, s, 'GET', `/api/v1/transfers/${id}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Job;
};
async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settled = (t: TestApp, s: S, id: string) => until(() => jobOf(t, s, id), (j) => j.status !== 'running', `job ${id}`);
async function migrate(t: TestApp, s: S, body: { from: string; path: string; dir?: string; name: string }): Promise<Job> {
  const r = await as(t, s, 'POST', '/api/v1/migrations', { dir: '/', ...body });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as Job;
}
async function cleanup(t: TestApp, s: S, id: string): Promise<Job> {
  const preview = await as(t, s, 'GET', `/api/v1/migrations/${id}/cleanup`);
  expect(preview.statusCode, preview.body).toBe(200);
  const r = await as(t, s, 'POST', `/api/v1/migrations/${id}/cleanup`, { token: preview.json().token });
  expect(r.statusCode, r.body).toBe(201);
  return settled(t, s, (r.json() as Job).id);
}
/** The summary export as rows of cells; the header row is first. */
async function report(t: TestApp, s: S, id: string): Promise<string[][]> {
  const r = await as(t, s, 'GET', `/api/v1/transfers/${id}/report`);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.headers['content-type']).toMatch(/^text\/csv/);
  expect(r.headers['content-disposition']).toMatch(/^attachment; filename="transfer-[0-9a-f]{32}\.csv"$/);
  return r.body.trimEnd().split('\r\n').map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"')));
}
const home = (t: TestApp, s: S) => homeRoot(t.config.dataDir, s.id);
const filesUnder = (dir: string): string[] => existsSync(dir)
  ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name).slice(dir.length)).sort() : [];

describe('migrating a cloud account or folder to the shard', () => {
  let t: TestApp; let fake: FakeProvider; let a: S; let b: S; let conn: string;
  const owned = new Map<string, ConnectedBackend[]>();
  let memN = 0;
  /** A fake connection of testuser's (an in-memory cloud), as `conn:<id>`. */
  const mem = (o: { withMd5?: boolean } = {}) => {
    const m = new MemBackend(o); const id = `mem${memN++}`;
    owned.get(a.id)!.push({ id, backend: m });
    return { m, source: `conn:${id}` };
  };

  beforeAll(async () => {
    fake = await startFakeProvider({ pageSize: 2 });
    t = await startTestApp({}, undefined, undefined, { providers: [fake.provider(), fake.driveProvider()],
      connections: async (u) => [...await t.app.deps.cloud.backends(u.id), ...(owned.get(u.id) ?? [])] });
    a = await signIn(t, 'testuser');
    b = await signIn(t, 'member');
    owned.set(a.id, []);
    owned.set(b.id, []);
    const r = await as(t, a, 'POST', '/api/v1/connections/authorize', { provider: 'fake' });
    const back = await fake.consent(r.json().url as string);
    const cb = await as(t, a, 'GET', back.pathname + back.search);
    conn = /^\/(conn:[0-9a-f]{32})$/.exec(String(cb.headers.location))![1]!;
  });
  afterAll(async () => { await t.close(); await fake.close(); });

  it('migrates 50 files in nested folders identically; two broken downloads are in the summary and the job is completed_with_errors', async () => {
    const content = new Map<string, Buffer>();
    for (let i = 0; i < 50; i++) {
      const path = `/Archive/${['2023', '2024', '2025'][i % 3]}/${i % 2 ? 'raw/' : ''}file-${i}.bin`;
      content.set(path, randomBytes(1000 + i * 37));
      fake.put(path, content.get(path)!);
    }
    const broken = ['/Archive/2024/raw/file-7.bin', '/Archive/2023/file-12.bin'];
    for (const p of broken) { expect(content.has(p), p).toBe(true); fake.truncateContent(p); }

    // Review before the start: count and size of what will be migrated.
    const scan = await as(t, a, 'GET', `/api/v1/migrations/scan?source=${conn}&path=%2FArchive`);
    expect(scan.statusCode, scan.body).toBe(200);
    const bytes = [...content.values()].reduce((x, d) => x + d.length, 0);
    expect(scan.json()).toEqual({ files: 50, folders: 6, bytes, complete: true });

    const job = await migrate(t, a, { from: conn, path: '/Archive', name: 'From the cloud' });
    expect(job).toMatchObject({ kind: 'migration', status: 'running' });
    const done = await settled(t, a, job.id);
    expect(done.status).toBe('completed_with_errors');
    expect(done.failed.sort((x, y) => x.path.localeCompare(y.path))).toEqual(
      [...broken].sort().map((path) => ({ path, code: 'SIZE_MISMATCH' })));
    expect(done).toMatchObject({ total: 57, done: 55, verifiedFiles: 48 });

    const root = join(home(t, a), 'From the cloud');
    const expected = [...content.keys()].filter((p) => !broken.includes(p)).map((p) => p.slice('/Archive'.length)).sort();
    expect(filesUnder(root)).toEqual(expected);
    for (const rel of expected) expect(Buffer.compare(readFileSync(join(root, rel)), content.get(`/Archive${rel}`)!), rel).toBe(0);

    const rows = await report(t, a, job.id);
    expect(rows[0]).toEqual(['status', 'source_path', 'shard_path', 'type', 'bytes', 'verified', 'error', 'renamed']);
    const files = rows.slice(1).filter((r) => r[3] === 'file');
    expect(files).toHaveLength(50);
    for (const p of broken) expect(files.find((r) => r[1] === p)).toEqual(['failed', p, '', 'file', '0', '', 'SIZE_MISMATCH', '']);
    const ok = files.find((r) => r[1] === '/Archive/2025/file-2.bin')!;
    expect(ok).toEqual(['done', '/Archive/2025/file-2.bin', '/From the cloud/2025/file-2.bin', 'file',
      String(content.get('/Archive/2025/file-2.bin')!.length), 'size sha256', '', '']);
  });

  it('migrates a whole account into a new folder and never into one the member already has', async () => {
    const { m, source } = mem();
    m.put('/top.txt', 'at the root').put('/Docs/inner.txt', 'inside');
    writeFileSync(join(home(t, a), 'Taken'), 'mine, not the cloud\'s');
    const done = await settled(t, a, (await migrate(t, a, { from: source, path: '/', name: 'Taken' })).id);
    expect(done).toMatchObject({ status: 'completed', failed: [], name: 'Taken (1)' });
    expect(readFileSync(join(home(t, a), 'Taken'), 'utf8')).toBe('mine, not the cloud\'s');
    expect(readFileSync(join(home(t, a), 'Taken (1)', 'top.txt'), 'utf8')).toBe('at the root');
    expect(readFileSync(join(home(t, a), 'Taken (1)', 'Docs', 'inner.txt'), 'utf8')).toBe('inside');
  });

  it('lists every folder before copying files, so the file total matches the scan while files are still copying (#227)', async () => {
    const { m, source } = mem();
    m.put('/M/a.txt', 'first').put('/M/b.txt', 'second').put('/M/z/deep/c.txt', 'third');
    // Both files at the top stall, holding every worker; only folders listed before them count.
    m.stall('/M/a.txt'); m.stall('/M/b.txt');
    const scan = (await as(t, a, 'GET', `/api/v1/migrations/scan?source=${source}&path=%2FM`)).json() as { files: number };
    expect(scan.files).toBe(3);
    const job = await migrate(t, a, { from: source, path: '/M', name: 'M listed' });
    expect(job).toMatchObject({ status: 'running', listing: true });
    const mid = await until(() => jobOf(t, a, job.id), (j) => !j.listing, 'the listing', 3000);
    expect(mid).toMatchObject({ status: 'running', files: scan.files });
    m.release('/M/a.txt'); m.release('/M/b.txt');
    expect(await settled(t, a, job.id)).toMatchObject({ status: 'completed', files: 3, verifiedFiles: 3, listing: false });
  });

  it('a migration from Google Drive also checks Drive\'s MD5 of every file', async () => {
    fake.drive.put('/Trip/day1.txt', 'sand and sea');
    const r = await as(t, a, 'POST', '/api/v1/connections/authorize', { provider: 'google-drive' });
    const back = await fake.consent(r.json().url as string);
    const drive = /^\/(conn:[0-9a-f]{32})$/.exec(String((await as(t, a, 'GET', back.pathname + back.search)).headers.location))![1]!;
    const job = await migrate(t, a, { from: drive, path: '/Trip', name: 'Trip' });
    expect(await settled(t, a, job.id)).toMatchObject({ status: 'completed' });
    expect((await report(t, a, job.id)).find((row) => row[1] === '/Trip/day1.txt')?.[5]).toBe('size sha256 md5');
  });

  it('bytes that do not match the provider\'s MD5 fail verification', async () => {
    const { m, source } = mem({ withMd5: true });
    m.put('/M/good.txt', 'right').put('/M/bad.txt', 'wrong');
    m.lieMd5.add('/M/bad.txt');
    const done = await settled(t, a, (await migrate(t, a, { from: source, path: '/M', name: 'M' })).id);
    expect(done).toMatchObject({ status: 'completed_with_errors', failed: [{ path: '/M/bad.txt', code: 'VERIFY_FAILED' }] });
  });

  it('refuses a source that is not one of the caller\'s connections, and a file as the folder', async () => {
    const { m, source } = mem();
    m.put('/one.txt', 'one');
    const before = t.db.prepare('SELECT count(*) FROM transfer_jobs').pluck().get();
    const body = { path: '/', dir: '/', name: 'x' };
    expect((await as(t, a, 'POST', '/api/v1/migrations', { ...body, from: 'home' })).json()).toEqual({ code: 'VALIDATION' });
    const other = await as(t, b, 'POST', '/api/v1/migrations', { ...body, from: source });
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual({ code: 'SOURCE_NOT_FOUND' });
    expect((await as(t, a, 'POST', '/api/v1/migrations', { ...body, from: source, path: '/one.txt' })).json()).toEqual({ code: 'NOT_A_DIRECTORY' });
    for (const name of ['', '..', 'a/b']) {
      expect((await as(t, a, 'POST', '/api/v1/migrations', { ...body, from: source, name })).statusCode, name).toBe(400);
    }
    expect((await as(t, b, 'GET', `/api/v1/migrations/scan?source=${source}&path=%2F`)).statusCode).toBe(404);
    expect(t.db.prepare('SELECT count(*) FROM transfer_jobs').pluck().get()).toBe(before);
  });

  it('cleanup deletes only verified files from the cloud; failed items and folders stay', async () => {
    const { m, source } = mem({ withMd5: true });
    m.put('/Old/a.txt', 'alpha').put('/Old/sub/b.txt', 'bravo').put('/Old/sub/bad-hash.txt', 'charlie').put('/Old/short.txt', 'delta');
    m.lieMd5.add('/Old/sub/bad-hash.txt'); // its bytes land on the shard intact, but it is not verified
    m.lieSize.set('/Old/short.txt', 99);
    const mig = await settled(t, a, (await migrate(t, a, { from: source, path: '/Old', name: 'Old' })).id);
    expect(mig.failed.map((f) => f.code).sort()).toEqual(['SIZE_MISMATCH', 'VERIFY_FAILED']);
    expect(readFileSync(join(home(t, a), 'Old', 'sub', 'bad-hash.txt'), 'utf8')).toBe('charlie');

    const preview = await as(t, a, 'GET', `/api/v1/migrations/${mig.id}/cleanup`);
    expect(preview.json()).toMatchObject({ files: 2, bytes: 10 });
    const done = await cleanup(t, a, mig.id);
    expect(done).toMatchObject({ kind: 'cleanup', origin: mig.id, status: 'completed', total: 2, done: 2, failed: [] });
    expect(m.deleted.sort()).toEqual(['/Old/a.txt', '/Old/sub/b.txt']);
    expect([...m.files.keys()].sort()).toEqual(['/Old/short.txt', '/Old/sub/bad-hash.txt']);
    expect(m.dirs.has('/Old/sub')).toBe(true);
    // The shard copies are untouched.
    expect(readFileSync(join(home(t, a), 'Old', 'a.txt'), 'utf8')).toBe('alpha');
  });

  it('cleanup keeps a cloud file whose shard copy changed or which changed in the cloud since the migration', async () => {
    const { m, source } = mem();
    m.put('/C/copy-edited.txt', 'original').put('/C/copy-gone.txt', 'original').put('/C/cloud-edited.txt', 'original')
      .put('/C/fine.txt', 'original');
    const mig = await settled(t, a, (await migrate(t, a, { from: source, path: '/C', name: 'C' })).id);
    expect(mig.status).toBe('completed');
    writeFileSync(join(home(t, a), 'C', 'copy-edited.txt'), 'ORIGINAL'); // same size, other bytes
    await as(t, a, 'POST', '/api/v1/sources/home/delete', { paths: ['/C/copy-gone.txt'] });
    m.put('/C/cloud-edited.txt', 'ORIGINAL'); // same size, newer
    const done = await cleanup(t, a, mig.id);
    expect(done.status).toBe('completed_with_errors');
    expect(done.failed.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: '/C/cloud-edited.txt', code: 'SOURCE_CHANGED' },
      { path: '/C/copy-edited.txt', code: 'COPY_CHANGED' },
      { path: '/C/copy-gone.txt', code: 'COPY_CHANGED' },
    ]);
    expect(m.deleted).toEqual(['/C/fine.txt']);
  });

  it('a cleanup refused for the member\'s running jobs (JOB_LIMIT, #380) keeps its token and deletes nothing', async () => {
    const { m, source } = mem();
    m.put('/L/x.txt', 'x');
    const mig = await settled(t, a, (await migrate(t, a, { from: source, path: '/L', name: 'L' })).id);
    const url = `/api/v1/migrations/${mig.id}/cleanup`;
    const token = (await as(t, a, 'GET', url)).json().token as string;
    // Ten running jobs of testuser's, each held at its first read.
    const { m: slow, source: from } = mem();
    mkdirSync(join(home(t, a), 'held'), { recursive: true });
    const paths = Array.from({ length: 10 }, (_, i) => `/held/${i}.bin`);
    const held: Job[] = [];
    for (const p of paths) {
      slow.put(p, randomBytes(1000)); slow.stall(p);
      const r = await as(t, a, 'POST', '/api/v1/transfers', { mode: 'copy', from, to: 'home', dir: '/held',
        items: [{ path: p, onCollision: 'fail' }] });
      expect(r.statusCode, r.body).toBe(201);
      held.push(r.json() as Job);
    }
    const refused = await as(t, a, 'POST', url, { token });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'JOB_LIMIT' });
    expect(m.deleted).toEqual([]);
    // Once one job ends, the same token starts the cleanup.
    expect((await as(t, a, 'POST', `/api/v1/transfers/${held[0]!.id}/cancel`)).statusCode).toBe(200);
    const r = await as(t, a, 'POST', url, { token });
    expect(r.statusCode, r.body).toBe(201);
    for (const p of paths) slow.release(p);
    expect((await settled(t, a, (r.json() as Job).id)).status).toBe('completed');
    expect(m.deleted).toEqual(['/L/x.txt']);
    for (const j of held.slice(1)) expect((await settled(t, a, j.id)).status).toBe('completed');
  });

  it('cleanup without a valid confirmation token is refused and deletes nothing', async () => {
    const { m, source } = mem();
    m.put('/T/x.txt', 'x');
    const mig = await settled(t, a, (await migrate(t, a, { from: source, path: '/T', name: 'T' })).id);
    const url = `/api/v1/migrations/${mig.id}/cleanup`;
    const jobs = () => t.db.prepare('SELECT count(*) FROM transfer_jobs').pluck().get();
    const before = jobs();
    for (const [payload, status] of [[{}, 400], [{ token: '' }, 400], [{ token: 'f'.repeat(32) }, 428]] as const) {
      expect((await as(t, a, 'POST', url, payload)).statusCode, JSON.stringify(payload)).toBe(status);
    }
    // Without a preview first there is no token at all, so any token is refused.
    expect((await as(t, a, 'POST', url, { token: 'f'.repeat(32) })).json()).toEqual({ code: 'CONFIRMATION_REQUIRED' });
    const token = (await as(t, a, 'GET', url)).json().token as string;
    // Another member cannot use it, and an expired one is refused.
    expect((await as(t, b, 'POST', url, { token })).statusCode).toBe(404);
    t.db.prepare('UPDATE transfer_jobs SET cleanup_expires = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), mig.id);
    expect((await as(t, a, 'POST', url, { token })).json()).toEqual({ code: 'CONFIRMATION_REQUIRED' });
    expect(jobs()).toBe(before);
    expect(m.deleted).toEqual([]);
    // A fresh token works exactly once.
    const fresh = (await as(t, a, 'GET', url)).json().token as string;
    expect((await as(t, a, 'POST', url, { token: fresh })).statusCode).toBe(201);
    expect((await as(t, a, 'POST', url, { token: fresh })).json()).toEqual({ code: 'CONFIRMATION_REQUIRED' });
  });

  it('cleanup is only for the caller\'s own migration once it has ended', async () => {
    const { m, source } = mem();
    m.put('/R/slow.bin', randomBytes(10_000));
    m.stall('/R/slow.bin');
    const mig = await migrate(t, a, { from: source, path: '/R', name: 'R' });
    await until(() => jobOf(t, a, mig.id), (j) => j.total === 2, 'the folder listed');
    expect((await as(t, a, 'GET', `/api/v1/migrations/${mig.id}/cleanup`)).json()).toEqual({ code: 'JOB_RUNNING' });
    m.release('/R/slow.bin');
    await settled(t, a, mig.id);
    expect((await as(t, b, 'GET', `/api/v1/migrations/${mig.id}/cleanup`)).statusCode).toBe(404);
    // A plain transfer is not a migration.
    const { m: m2, source: s2 } = mem();
    m2.put('/p.txt', 'p');
    const tr = await as(t, a, 'POST', '/api/v1/transfers', { mode: 'copy', from: s2, to: 'home', dir: '/', items: [{ path: '/p.txt', onCollision: 'keep-both' }] });
    await settled(t, a, tr.json().id as string);
    expect((await as(t, a, 'GET', `/api/v1/migrations/${tr.json().id as string}/cleanup`)).statusCode).toBe(404);
    expect((await as(t, b, 'GET', `/api/v1/transfers/${mig.id}/report`)).statusCode).toBe(404);
  });
});
