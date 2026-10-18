import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { homeRoot } from '../src/paths.ts';
import type { ConnectedBackend } from '../src/storage/backend.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { startFakeProvider, type FakeProvider } from './support/fakeProvider.ts';
import { MemBackend } from './support/memBackend.ts';

// #152: copies and moves between sources run as persistent jobs. An item is done only once the target is verified
// (size, plus SHA-256 where a side offers a digest); a move deletes the source only after that. Regressions for #99
// (success without work, move degrading to copy) and #64 (resume, cancel, progress).

type S = { cookie: string; csrf: string; id: string };
type Job = { id: string; status: string; total: number; done: number; failed: { path: string; code: string }[]; cancelled: number };
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
type Start = { mode?: 'copy' | 'move'; from: string; to: string; dir: string; paths: string[]; onCollision?: string };
async function start(t: TestApp, s: S, o: Start): Promise<Job> {
  const r = await as(t, s, 'POST', '/api/v1/transfers', { mode: o.mode ?? 'copy', from: o.from, to: o.to, dir: o.dir,
    items: o.paths.map((path) => ({ path, onCollision: o.onCollision ?? 'fail' })) });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as Job;
}
const jobOf = async (t: TestApp, s: S, id: string) => {
  const r = await as(t, s, 'GET', `/api/v1/transfers/${id}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Job;
};
async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settled = (t: TestApp, s: S, id: string) => until(() => jobOf(t, s, id), (j) => j.status !== 'running', `job ${id}`);
const home = (t: TestApp, s: S) => homeRoot(t.config.dataDir, s.id);
// Every file under a home folder, temp files included (readdir sees dot files).
const filesUnder = (dir: string): string[] => existsSync(dir)
  ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name) : [];
let n = 0;
const fresh = (t: TestApp, s: S, stem: string) => { const d = `/${stem}-${++n}`; mkdirSync(join(home(t, s), d), { recursive: true }); return d; };

describe('transfer jobs between sources', () => {
  let t: TestApp; let fake: FakeProvider; let a: S; let b: S;
  // Fake connections per member: `mem()` adds one to testuser's, `owned` holds them by user id.
  const owned = new Map<string, ConnectedBackend[]>();
  const mems: ConnectedBackend[] = [];
  const mem =(o: { withDigest?: boolean } = {}) => { const m = new MemBackend(o); const id = `mem${mems.length}`; mems.push({ id, backend: m }); return { m, source: `conn:${id}` }; };

  beforeAll(async () => {
    fake = await startFakeProvider({ pageSize: 2 });
    t = await startTestApp({}, undefined, undefined, { providers: [fake.driveProvider()],
      connections: async (u) => [...await t.app.deps.cloud.backends(u.id), ...(owned.get(u.id) ?? [])] });
    a = await signIn(t, 'testuser');
    b = await signIn(t, 'member');
    owned.set(a.id, mems);
    owned.set(b.id, []);
  });
  afterAll(async () => { await t.close(); await fake.close(); });

  it('copies a folder from a Google Drive to the home with identical bytes and reports completed', async () => {
    const big = randomBytes(300_000);
    fake.drive.put('/Album/note.txt', 'from the drive');
    fake.drive.put('/Album/raw/photo.bin', big);
    const r = await as(t, a, 'POST', '/api/v1/connections/authorize', { provider: 'google-drive' });
    const back = await fake.consent(r.json().url as string);
    const cb = await as(t, a, 'GET', back.pathname + back.search);
    const conn = /^\/(conn:[0-9a-f]{32})$/.exec(String(cb.headers.location))![1]!;
    const dir = fresh(t, a, 'drive');

    const job = await start(t, a, { from: conn, to: 'home', dir, paths: ['/Album'] });
    const done = await settled(t, a, job.id);
    expect(done).toMatchObject({ status: 'completed', total: 4, done: 4, failed: [], cancelled: 0 });
    expect(readFileSync(join(home(t, a), dir, 'Album/note.txt'), 'utf8')).toBe('from the drive');
    expect(Buffer.compare(readFileSync(join(home(t, a), dir, 'Album/raw/photo.bin')), big)).toBe(0);
  });

  it('a source that sends fewer bytes than it claims fails that item and the job ends completed_with_errors', async () => {
    const { m, source } = mem();
    m.put('/ok.txt', 'fine').put('/short.txt', 'only part');
    m.lieSize.set('/short.txt', 99);
    const dir = fresh(t, a, 'short');
    const done = await settled(t, a, (await start(t, a, { from: source, to: 'home', dir, paths: ['/ok.txt', '/short.txt'] })).id);
    expect(done).toMatchObject({ status: 'completed_with_errors', total: 2, done: 1, failed: [{ path: '/short.txt', code: 'SIZE_MISMATCH' }] });
    expect(filesUnder(join(home(t, a), dir))).toEqual(['ok.txt']);
  });

  it('a short source fails even when the target does not check the declared size', async () => {
    const { m: src, source: from } = mem();
    const { m: target, source: to } = mem();
    target.ignoreSize = true;
    src.put('/short.txt', 'only part');
    src.lieSize.set('/short.txt', 99);
    const done = await settled(t, a, (await start(t, a, { from, to, dir: '/', paths: ['/short.txt'] })).id);
    expect(done).toMatchObject({ status: 'completed_with_errors', done: 0, failed: [{ path: '/short.txt', code: 'SIZE_MISMATCH' }] });
  });

  it('a target that stores fewer bytes than were sent fails verification', async () => {
    const { m: target, source: to } = mem();
    target.truncateWrites = true;
    const dir = fresh(t, a, 'trunc');
    writeFileSync(join(home(t, a), dir, 'x.txt'), 'twelve bytes');
    const done = await settled(t, a, (await start(t, a, { from: 'home', to, dir: '/', paths: [`${dir}/x.txt`] })).id);
    expect(done).toMatchObject({ status: 'completed_with_errors', done: 0, failed: [{ path: `${dir}/x.txt`, code: 'VERIFY_FAILED' }] });
  });

  it('no report cell starts with a formula character, even for a name that starts with one (#306)', async () => {
    // Excel and LibreOffice evaluate a CSV cell that starts with = + - @ tab or CR. Every path in the report is absolute,
    // so such a name only ever follows a `/`; the other cells are statuses, types, sizes, checks and error codes.
    const name = '=HYPERLINK("example.com","x")';
    const { m, source: cloud } = mem();
    m.put(`/${name}`, 'from the cloud');
    const dir = fresh(t, a, 'formula');
    writeFileSync(join(home(t, a), dir, name), 'from the home');
    const cells = async (id: string) => {
      const r = await as(t, a, 'GET', `/api/v1/transfers/${id}/report`);
      expect(r.statusCode, r.body).toBe(200);
      return r.body.trimEnd().split('\r\n').map((line) => {
        const quoted = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((c) => c[0]);
        expect(quoted.join(','), 'the line is quoted cells and nothing else').toBe(line);
        return quoted.map((c) => c.slice(1, -1).replace(/""/g, '"'));
      });
    };
    const down = await settled(t, a, (await start(t, a,
      { from: cloud, to: 'home', dir, paths: [`/${name}`], onCollision: 'keep-both' })).id);
    const up = await settled(t, a, (await start(t, a,
      { from: 'home', to: cloud, dir: '/', paths: [`${dir}/${name}`], onCollision: 'keep-both' })).id);
    for (const job of [down, up]) expect(job).toMatchObject({ status: 'completed', done: 1 });
    const downRows = await cells(down.id);
    const upRows = await cells(up.id);
    expect(downRows).toHaveLength(2);
    expect(upRows).toHaveLength(2);
    expect(downRows[1]!.slice(0, 2)).toEqual(['done', `/${name}`]);
    expect(downRows[1]![2]!.startsWith(`${dir}/=HYPERLINK(`)).toBe(true);
    expect(upRows[1]!.slice(0, 2)).toEqual(['done', `${dir}/${name}`]);
    expect(upRows[1]![2]!.startsWith('/=HYPERLINK(')).toBe(true);
    for (const row of [...downRows, ...upRows]) {
      expect(row, JSON.stringify(row)).toHaveLength(8); // every cell is quoted, so none escapes the check below
      for (const cell of row) expect(cell, JSON.stringify(row)).not.toMatch(/^[=+\-@\t\r]/);
    }
  });

  it('a target that stores other bytes of the same size fails the hash check', async () => {
    const { m: target, source: to } = mem({ withDigest: true });
    target.corruptWrites = true;
    const dir = fresh(t, a, 'corrupt');
    writeFileSync(join(home(t, a), dir, 'x.txt'), 'same length');
    const done = await settled(t, a, (await start(t, a, { from: 'home', to, dir: '/', paths: [`${dir}/x.txt`] })).id);
    expect(done).toMatchObject({ status: 'completed_with_errors', done: 0, failed: [{ path: `${dir}/x.txt`, code: 'VERIFY_FAILED' }] });
  });

  it('a move whose verification fails leaves the source in place', async () => {
    const { m: target, source: to } = mem();
    target.truncateWrites = true;
    const dir = fresh(t, a, 'move-bad');
    writeFileSync(join(home(t, a), dir, 'keep.txt'), 'do not lose me');
    const done = await settled(t, a, (await start(t, a, { mode: 'move', from: 'home', to, dir: '/', paths: [dir] })).id);
    expect(done.status).toBe('completed_with_errors');
    expect(done.failed).toEqual([{ path: `${dir}/keep.txt`, code: 'VERIFY_FAILED' }]);
    expect(readFileSync(join(home(t, a), dir, 'keep.txt'), 'utf8')).toBe('do not lose me');
    expect((await as(t, a, 'GET', '/api/v1/trash')).json().items).toEqual([]);
  });

  it('a verified move deletes the source (into the trash) and the target has the bytes', async () => {
    const { m: target, source: to } = mem();
    const dir = fresh(t, a, 'move-ok');
    writeFileSync(join(home(t, a), dir, 'go.txt'), 'moving out');
    const done = await settled(t, a, (await start(t, a, { mode: 'move', from: 'home', to, dir: '/', paths: [dir] })).id);
    expect(done).toMatchObject({ status: 'completed', total: 2, done: 2, failed: [] });
    expect(target.files.get(`${dir}/go.txt`)?.toString()).toBe('moving out');
    expect(existsSync(join(home(t, a), dir))).toBe(false);
    expect((await as(t, a, 'GET', '/api/v1/trash')).json().items.map((i: { originalPath: string }) => i.originalPath)).toContain(dir);
  });

  it('cancel stops new items and leaves no partial target files', async () => {
    const { m, source } = mem();
    const paths = ['/1.bin', '/2.bin', '/3.bin', '/4.bin', '/5.bin'];
    for (const p of paths) { m.put(p, randomBytes(200_000)); m.stall(p); }
    const dir = fresh(t, a, 'cancel');
    const job = await start(t, a, { from: source, to: 'home', dir, paths });
    // At least one item is mid-stream: its temp file is in the target folder.
    await until(async () => filesUnder(join(home(t, a), dir)), (f) => f.length > 0, 'a partial target file');
    const r = await as(t, a, 'POST', `/api/v1/transfers/${job.id}/cancel`);
    expect(r.statusCode, r.body).toBe(200);
    for (const p of paths) m.release(p);
    // The job is cancelled at once; the items in flight follow once their writes have cleaned up.
    const done = await until(() => jobOf(t, a, job.id), (j) => j.cancelled + j.done + j.failed.length === j.total, 'every item settled');
    expect(done).toMatchObject({ status: 'cancelled', done: 0, cancelled: 5 });
    await new Promise((res) => setTimeout(res, 100)); // nothing may still be on its way
    expect(filesUnder(join(home(t, a), dir))).toEqual([]);
    const started = [...m.reads.values()].reduce((x, y) => x + y, 0);
    expect(started).toBeGreaterThan(0);
    expect(started).toBeLessThan(paths.length);
  });

  it('another member gets 404 for the job, cannot cancel it and does not list it', async () => {
    const { m, source } = mem();
    m.put('/mine.txt', 'mine');
    const job = await start(t, a, { from: source, to: 'home', dir: fresh(t, a, 'own'), paths: ['/mine.txt'] });
    await settled(t, a, job.id);
    expect((await as(t, b, 'GET', `/api/v1/transfers/${job.id}`)).json()).toEqual({ code: 'NOT_FOUND' });
    expect((await as(t, b, 'GET', `/api/v1/transfers/${job.id}`)).statusCode).toBe(404);
    expect((await as(t, b, 'POST', `/api/v1/transfers/${job.id}/cancel`)).statusCode).toBe(404);
    expect((await as(t, b, 'GET', '/api/v1/transfers')).json().items).toEqual([]);
    expect((await as(t, a, 'GET', '/api/v1/transfers')).json().items.map((j: Job) => j.id)).toContain(job.id);
  });

  it('refuses a source the caller cannot reach before a job exists', async () => {
    const before = t.db.prepare('SELECT count(*) FROM transfer_jobs').pluck().get();
    const r = await as(t, b, 'POST', '/api/v1/transfers', { mode: 'copy', from: mems[0] ? `conn:${mems[0].id}` : 'conn:x', to: 'home',
      dir: '/', items: [{ path: '/ok.txt', onCollision: 'fail' }] });
    expect(r.json()).toEqual({ code: 'SOURCE_NOT_FOUND' });
    expect(t.db.prepare('SELECT count(*) FROM transfer_jobs').pluck().get()).toBe(before);
  });

  // #256: a transfer writes into its target and, as a move, deletes from its source; both need `edit` on a share.
  describe('a share as source or target', () => {
    // A fresh folder in testuser's home with one file, shared with `member` at `access`; answers its source id.
    async function shared(access: 'read' | 'edit'): Promise<{ dir: string; source: string }> {
      const dir = fresh(t, a, 'shared');
      writeFileSync(join(home(t, a), dir, 'theirs.txt'), 'owner bytes');
      const r = await as(t, a, 'POST', '/api/v1/shares', { source: 'home', path: dir, grantee: b.id, access });
      expect(r.statusCode, r.body).toBeLessThan(300);
      return { dir, source: `share:${r.json().id as string}` };
    }
    const jobs = () => t.db.prepare('SELECT count(*) FROM transfer_jobs').pluck().get();

    it('a copy into a read share answers 403 before a job exists and writes nothing', async () => {
      const { dir, source } = await shared('read');
      mkdirSync(join(home(t, b), '/mine'), { recursive: true });
      writeFileSync(join(home(t, b), '/mine/intruder.txt'), 'member bytes');
      const before = jobs();
      const r = await as(t, b, 'POST', '/api/v1/transfers', { mode: 'copy', from: 'home', to: source, dir: '/',
        items: [{ path: '/mine/intruder.txt', onCollision: 'fail' }] });
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json()).toEqual({ code: 'FORBIDDEN' });
      expect(jobs()).toBe(before);
      expect(filesUnder(join(home(t, a), dir))).toEqual(['theirs.txt']);
    });

    it('a move out of a read share answers 403 before a job exists and leaves the source in place', async () => {
      const { dir, source } = await shared('read');
      const before = jobs();
      const r = await as(t, b, 'POST', '/api/v1/transfers', { mode: 'move', from: source, to: 'home', dir: '/',
        items: [{ path: '/theirs.txt', onCollision: 'keep-both' }] });
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json()).toEqual({ code: 'FORBIDDEN' });
      expect(jobs()).toBe(before);
      expect(readFileSync(join(home(t, a), dir, 'theirs.txt'), 'utf8')).toBe('owner bytes');
      // A copy out of a read share is reading, which `read` allows.
      const copy = await start(t, b, { from: source, to: 'home', dir: fresh(t, b, 'copied'), paths: ['/theirs.txt'] });
      expect(await settled(t, b, copy.id)).toMatchObject({ status: 'completed', done: 1 });
    });

    it('a share downgraded to read while the job runs fails the remaining items with FORBIDDEN and writes none of them', async () => {
      const { dir, source } = await shared('edit');
      const m = new MemBackend();
      owned.get(b.id)!.push({ id: 'memb', backend: m });
      const paths = ['/1.txt', '/2.txt', '/3.txt'];
      for (const p of paths) m.put(p, `bytes of ${p}`);
      m.stall('/1.txt'); m.stall('/2.txt');
      const job = await start(t, b, { from: 'conn:memb', to: source, dir: '/', paths });
      // Both concurrent items are mid-stream (their sources resolved while the share still allowed edit); 3 waits.
      await until(async () => m.reads.size, (n) => n === 2, 'two items reading');
      const down = await as(t, a, 'POST', '/api/v1/shares', { source: 'home', path: dir, grantee: b.id, access: 'read' });
      expect(down.statusCode, down.body).toBeLessThan(300);
      m.release('/1.txt'); m.release('/2.txt');
      const done = await settled(t, b, job.id);
      // Items 1 and 2 may finish or fail; only that 3 never ran with the old rights is pinned here.
      expect(done.failed).toContainEqual({ path: '/3.txt', code: 'FORBIDDEN' });
      expect(done.failed.every((f) => f.code === 'FORBIDDEN'), JSON.stringify(done.failed)).toBe(true);
      expect(m.reads.get('/3.txt') ?? 0).toBe(0);
      expect(existsSync(join(home(t, a), dir, '3.txt'))).toBe(false);
      expect(filesUnder(join(home(t, a), dir)).filter((f) => f.endsWith('.upload'))).toEqual([]);
    });

    it('a move out of a share downgraded to read while the job runs fails the remaining items and deletes none of them', async () => {
      // A folder of testuser's cloud connection (its reads can be held), shared with `member` at edit.
      const { m, source: conn } = mem();
      const paths = ['/1.txt', '/2.txt', '/3.txt'];
      for (const p of paths) m.put(`/Shared${p}`, `bytes of ${p}`);
      m.stall('/Shared/1.txt'); m.stall('/Shared/2.txt');
      const share = async (access: 'read' | 'edit') => {
        const r = await as(t, a, 'POST', '/api/v1/shares', { source: conn, path: '/Shared', grantee: b.id, access });
        expect(r.statusCode, r.body).toBeLessThan(300);
        return `share:${r.json().id as string}`;
      };
      const source = await share('edit');
      const dir = fresh(t, b, 'moved');
      const job = await start(t, b, { mode: 'move', from: source, to: 'home', dir, paths });
      await until(async () => m.reads.size, (n) => n === 2, 'two items reading');
      await share('read');
      m.release('/Shared/1.txt'); m.release('/Shared/2.txt');
      const done = await settled(t, b, job.id);
      // Items 1 and 2 may finish or fail; only that 3 never ran with the old rights is pinned here.
      expect(done.failed).toContainEqual({ path: '/3.txt', code: 'FORBIDDEN' });
      expect(done.failed.every((f) => f.code === 'FORBIDDEN'), JSON.stringify(done.failed)).toBe(true);
      expect(m.reads.get('/Shared/3.txt') ?? 0).toBe(0);
      expect(m.files.get('/Shared/3.txt')?.toString()).toBe('bytes of /3.txt');
      expect(m.deleted).not.toContain('/Shared/3.txt');
      expect(existsSync(join(home(t, b), dir, '3.txt'))).toBe(false);
    });
  });

  it('SSE progress reaches only the job owner', async () => {
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
    const events = (s: S) => {
      const ctl = new AbortController(); let text = '';
      const ready = fetch(`${base}/api/v1/transfers/events`, { headers: { cookie: s.cookie }, signal: ctl.signal }).then(async (res) => {
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
        const reader = res.body!.getReader(); const dec = new TextDecoder();
        void (async () => {
          for (;;) {
            const c = await reader.read().catch(() => ({ done: true, value: undefined })); // handled: the abort ends the reading
            if (c.done) return;
            text += dec.decode(c.value);
          }
        })();
      });
      return { ready, text: () => text, close: () => ctl.abort() };
    };
    const ea = events(a); const eb = events(b);
    await Promise.all([ea.ready, eb.ready]);
    const { m, source } = mem();
    m.put('/s.txt', 'streamed');
    const job = await start(t, a, { from: source, to: 'home', dir: fresh(t, a, 'sse'), paths: ['/s.txt'] });
    await until(async () => ea.text(), (x) => x.includes(job.id) && x.includes('"completed"'), 'the owner\'s completed event');
    expect(ea.text()).toMatch(/^event: job$/m);
    // The member then starts a job of their own: once its event arrives, everything sent before it has arrived too.
    const mb = new MemBackend().put('/theirs.txt', 'theirs');
    owned.get(b.id)!.push({ id: 'memb', backend: mb });
    const r = await as(t, b, 'POST', '/api/v1/transfers', { mode: 'copy', from: 'conn:memb', to: 'home', dir: '/',
      items: [{ path: '/theirs.txt', onCollision: 'fail' }] });
    expect(r.statusCode, r.body).toBe(201);
    await until(async () => eb.text(), (x) => x.includes(r.json().id as string), 'the member\'s own event');
    expect(eb.text()).not.toContain(job.id);
    // A stream opened later starts with the caller's own jobs only.
    const late = events(b); await late.ready;
    await until(async () => late.text(), (x) => x.includes(r.json().id as string), 'the snapshot');
    expect(late.text()).not.toContain(job.id);
    ea.close(); eb.close(); late.close();
  });
});

describe('resume after a restart', () => {
  it('a job that was running continues at start-up and does not copy verified items again', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'files-resume-'));
    const content: Record<string, Buffer> = { '/a.bin': randomBytes(50_000), '/b.bin': randomBytes(50_000), '/c.bin': randomBytes(50_000) };
    const first = new MemBackend();
    for (const [p, d] of Object.entries(content)) first.put(p, d);
    first.stall('/c.bin');
    const t1 = await startTestApp({}, undefined, undefined, { dataDir, connections: async () => [{ id: 'src', backend: first }] });
    const a = await signIn(t1, 'testuser');
    mkdirSync(join(home(t1, a), 'in'), { recursive: true });
    const job = await start(t1, a, { from: 'conn:src', to: 'home', dir: '/in', paths: Object.keys(content) });
    await until(() => jobOf(t1, a, job.id), (j) => j.done === 2, 'a and b verified');
    await until(async () => filesUnder(join(home(t1, a), 'in')), (f) => f.length === 3, 'c mid-stream');
    await t1.close(); // the app goes away mid-job; c never finished
    first.release('/c.bin');

    const second = new MemBackend();
    for (const [p, d] of Object.entries(content)) second.put(p, d);
    const t2 = await startTestApp({}, undefined, undefined, { dataDir, connections: async () => [{ id: 'src', backend: second }] });
    try {
      const done = await settled(t2, a, job.id); // the session row survived the restart
      expect(done).toMatchObject({ status: 'completed', total: 3, done: 3, failed: [] });
      expect(Object.fromEntries(second.reads)).toEqual({ '/c.bin': 1 });
      for (const [p, d] of Object.entries(content)) expect(Buffer.compare(readFileSync(join(home(t2, a), 'in', p)), d), p).toBe(0);
      expect(filesUnder(join(home(t2, a), 'in')).sort()).toEqual(['a.bin', 'b.bin', 'c.bin']);
    } finally {
      await t2.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

// #280: a member's event streams are capped, so one session cannot hold an unbounded number of sockets, timers and
// listeners. Opening one more ends that member's oldest stream; other members are not affected.
describe('transfer event streams per member', () => {
  const CAP = 8;
  // `a2` is the same member signed in on a second device: the cap counts the member, not the session.
  let t: TestApp; let a: S; let a2: S; let b: S; let base: URL;
  beforeAll(async () => {
    t = await startTestApp();
    a = await signIn(t, 'testuser');
    a2 = await signIn(t, 'testuser');
    b = await signIn(t, 'member');
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    base = new URL(`http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`);
  });
  afterAll(async () => { await t.close(); });

  type Stream = { status: number; ended: () => boolean; closed: Promise<void>; destroy: () => void };
  const open = (s: S) => new Promise<Stream>((resolve, reject) => {
    const req = request(new URL('/api/v1/transfers/events', base), { headers: { cookie: s.cookie } }, (res) => {
      let ended = false;
      const closed = new Promise<void>((done) => { res.on('end', () => { ended = true; done(); }); });
      res.resume();
      resolve({ status: res.statusCode!, ended: () => ended, closed, destroy: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
  // A wait that only gives a wrongly ended stream the time to show it; a correct server never needs it.
  const settle = () => new Promise((r) => setTimeout(r, 150));
  const connections = () => new Promise<number>((resolve, reject) => {
    t.app.server.getConnections((e, n) => { if (e) reject(e); else resolve(n); });
  });

  it('one stream more than the cap ends the member\'s oldest, on any device; the others and other members\' stay open', async () => {
    const mine: Stream[] = [];
    for (let i = 0; i < CAP; i++) mine.push(await open(i < CAP / 2 ? a : a2));
    expect(mine.map((s) => s.status)).toEqual(Array(CAP).fill(200));
    await settle();
    expect(mine[0]!.ended()).toBe(false);
    const extra = await open(a2);
    expect(extra.status).toBe(200);
    await mine[0]!.closed; // without the cap this never resolves and the test times out
    // Another member is counted on their own: two streams of theirs end none of the first member's, nor each other.
    const theirs = [await open(b), await open(b)];
    expect(theirs.map((s) => s.status)).toEqual([200, 200]);
    await settle();
    expect(mine.slice(1).map((s) => s.ended())).toEqual(Array(CAP - 1).fill(false));
    expect(extra.ended()).toBe(false);
    expect(theirs.map((s) => s.ended())).toEqual([false, false]);
    for (const s of [...mine, extra, ...theirs]) s.destroy();
  });

  it('a stream the client closed frees its place', async () => {
    await until(connections, (n) => n === 0, 'the previous test\'s streams to close');
    const first = await open(b);
    const gone = await open(b);
    gone.destroy();
    await until(connections, (n) => n === 1, 'the closed stream to reach the server');
    const rest: Stream[] = [];
    for (let i = 0; i < CAP - 1; i++) rest.push(await open(b));
    await settle();
    expect(first.ended()).toBe(false);
    for (const s of [first, ...rest]) s.destroy();
  });
});
