import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeRoot } from '../src/paths.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { makeZip, type ZipEntrySpec } from './support/makeZip.ts';

// #322: export archives of iCloud Drive and Google Takeout (and plain ZIPs) import into a home folder as a transfer job
// of kind `import`, read straight from the archive; photo exports are skipped and named in the report; unsafe archives
// are refused before anything is extracted.

type S = { cookie: string; csrf: string; id: string };
type Job = { id: string; kind: string; status: string; total: number; done: number; failed: { path: string; code: string }[];
  skipped: { path: string; reason: string }[] };
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
async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const jobOf = async (t: TestApp, s: S, id: string) => (await as(t, s, 'GET', `/api/v1/transfers/${id}`)).json() as Job;
const settled = (t: TestApp, s: S, id: string) => until(() => jobOf(t, s, id), (j) => j.status !== 'running', `job ${id}`);
const home = (t: TestApp, s: S) => homeRoot(t.config.dataDir, s.id);
let n = 0;
/** Puts the archives into a fresh home folder and returns it, with an empty target folder `out` inside. */
function stage(t: TestApp, s: S, archives: Record<string, ZipEntrySpec[]>): string {
  const d = `/imp-${++n}`;
  mkdirSync(join(home(t, s), d, 'out'), { recursive: true });
  for (const [name, entries] of Object.entries(archives)) writeFileSync(join(home(t, s), d, name), makeZip(entries));
  return d;
}
const startImport = (t: TestApp, s: S, dir: string, archives: string[]) =>
  as(t, s, 'POST', '/api/v1/imports', { archives: archives.map((a) => `${dir}/${a}`), dir: `${dir}/out`, onCollision: 'keep-both' });
/** Every file below `root` as `relative path → content`. */
function tree(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter((d) => d.isFile())
    .map((d) => { const abs = join(d.parentPath, d.name); return [abs.slice(root.length + 1), readFileSync(abs, 'utf8')]; }));
}
const T1 = new Date('2021-03-04T05:06:08Z');
const T2 = new Date('2019-11-12T13:14:16Z');

describe('archive import', () => {
  let t: TestApp; let a: S;
  beforeAll(async () => { t = await startTestApp(); a = await signIn(t, 'testuser'); });
  afterAll(async () => { await t.close(); });

  it('imports a Google Takeout archive: Drive only, photos skipped, folders and mtimes kept', async () => {
    const dir = stage(t, a, { 'takeout-001.zip': [
      { name: 'Takeout/archive_browser.html', data: '<html>' },
      { name: 'Takeout/Drive/', },
      { name: 'Takeout/Drive/Docs/notes.txt', data: 'hello notes', mtime: T1, deflate: true },
      { name: 'Takeout/Drive/top.txt', data: 'top', mtime: T2 },
      { name: 'Takeout/Drive/Empty/' },
      { name: 'Takeout/Google Photos/2020/img.jpg', data: 'jpeg' },
      { name: 'Takeout/Google Photos/2021/img2.jpg', data: 'jpeg2' },
    ] });
    const r = await startImport(t, a, dir, ['takeout-001.zip']);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().kind).toBe('import');
    const job = await settled(t, a, r.json().id);
    expect(job.status).toBe('completed');
    expect(job.failed).toEqual([]);
    const out = join(home(t, a), dir, 'out');
    expect(tree(out)).toEqual({ 'Docs/notes.txt': 'hello notes', 'top.txt': 'top' });
    expect(statSync(join(out, 'Empty')).isDirectory()).toBe(true);
    expect(statSync(join(out, 'Docs/notes.txt')).mtime.toISOString()).toBe(T1.toISOString());
    expect(statSync(join(out, 'top.txt')).mtime.toISOString()).toBe(T2.toISOString());
    expect(job.skipped).toEqual(expect.arrayContaining([
      { path: `${dir}/takeout-001.zip/Takeout/Google Photos`, reason: 'photos' },
      { path: `${dir}/takeout-001.zip/Takeout/archive_browser.html`, reason: 'other' },
    ]));
    expect(job.skipped).toHaveLength(2);
    // The listing shows them too (the name index knows what the job wrote).
    const listed = await as(t, a, 'GET', `/api/v1/sources/home/list?path=${encodeURIComponent(`${dir}/out`)}`);
    expect((listed.json().entries as { name: string }[]).map((e) => e.name).sort()).toEqual(['Docs', 'Empty', 'top.txt']);
    const report = await as(t, a, 'GET', `/api/v1/transfers/${job.id}/report`);
    expect(report.body).toContain('"skipped"');
    expect(report.body).toContain('Google Photos');
  });

  it('merges an iCloud Drive export split into parts into one tree, iCloud Photos skipped', async () => {
    const dir = stage(t, a, {
      'iCloud Drive Part 1.zip': [
        { name: 'iCloud Drive/Pages/Letter.pages', data: 'letter', mtime: T1 },
        { name: 'iCloud Photos/IMG_0001.HEIC', data: 'heic' },
      ],
      'iCloud Drive Part 2.zip': [
        { name: 'iCloud Drive/Pages/Report.pages', data: 'report', mtime: T2 },
        { name: 'iCloud Drive/Downloads/a.pdf', data: 'pdf' },
      ],
    });
    const r = await startImport(t, a, dir, ['iCloud Drive Part 1.zip', 'iCloud Drive Part 2.zip']);
    expect(r.statusCode, r.body).toBe(201);
    const job = await settled(t, a, r.json().id);
    expect(job.status).toBe('completed');
    const out = join(home(t, a), dir, 'out');
    expect(tree(out)).toEqual({ 'Pages/Letter.pages': 'letter', 'Pages/Report.pages': 'report', 'Downloads/a.pdf': 'pdf' });
    expect(statSync(join(out, 'Pages/Report.pages')).mtime.toISOString()).toBe(T2.toISOString());
    expect(job.skipped).toEqual([{ path: `${dir}/iCloud Drive Part 1.zip/iCloud Photos`, reason: 'photos' }]);
  });

  it('takes a plain ZIP as it is, and a taken name follows the collision policy', async () => {
    const dir = stage(t, a, { 'plain.zip': [{ name: 'A/b.txt', data: 'new b' }, { name: 'c.txt', data: 'c' }] });
    mkdirSync(join(home(t, a), dir, 'out', 'A'));
    writeFileSync(join(home(t, a), dir, 'out', 'A', 'b.txt'), 'old b');
    const r = await startImport(t, a, dir, ['plain.zip']);
    expect(r.statusCode, r.body).toBe(201);
    const job = await settled(t, a, r.json().id);
    expect(job.status).toBe('completed');
    expect(tree(join(home(t, a), dir, 'out'))).toEqual({ 'A/b.txt': 'old b', 'A/b (1).txt': 'new b', 'c.txt': 'c' });
  });

  const refused: [string, ZipEntrySpec[], string][] = [
    ['a parent segment', [{ name: 'ok.txt', data: 'x' }, { name: 'a/../../escape.txt', data: 'x' }], 'ARCHIVE_UNSAFE'],
    ['an absolute path', [{ name: 'ok.txt', data: 'x' }, { name: '/etc/escape.txt', data: 'x' }], 'ARCHIVE_UNSAFE'],
    ['a symlink', [{ name: 'ok.txt', data: 'x' }, { name: 'link', data: '/etc/passwd', mode: 0o120777 }], 'ARCHIVE_UNSAFE'],
    ['a device', [{ name: 'ok.txt', data: 'x' }, { name: 'dev', mode: 0o020644 }], 'ARCHIVE_UNSAFE'],
    ['a zip bomb', [{ name: 'ok.txt', data: 'x' }, { name: 'bomb.bin', data: 'tiny', deflate: true, declaredSize: 0xF000_0000 }], 'ARCHIVE_TOO_LARGE'],
  ];
  it.each(refused)('refuses an archive with %s and extracts nothing', async (_what, entries, code) => {
    const dir = stage(t, a, { 'bad.zip': entries });
    const r = await startImport(t, a, dir, ['bad.zip']);
    expect(r.statusCode, r.body).toBe(201);
    const job = await settled(t, a, r.json().id);
    expect(job.status).toBe('completed_with_errors');
    expect(job.failed).toEqual([{ path: `${dir}/bad.zip`, code }]);
    expect(tree(join(home(t, a), dir, 'out'))).toEqual({});
    expect(existsSync(join(home(t, a), 'escape.txt'))).toBe(false);
  });

  it('refuses a path that is not a ZIP in the home', async () => {
    const dir = stage(t, a, {});
    writeFileSync(join(home(t, a), dir, 'not.zip'), 'just text');
    const r = await startImport(t, a, dir, ['not.zip']);
    const job = await settled(t, a, r.json().id);
    expect(job.failed).toEqual([{ path: `${dir}/not.zip`, code: 'ARCHIVE_INVALID' }]);
    expect((await startImport(t, a, dir, ['missing.zip'])).statusCode).toBe(404);
  });
});

describe('archive import after a restart', () => {
  it('a running import continues at start-up and writes no entry twice', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'files-import-resume-'));
    const entries = Array.from({ length: 400 }, (_, i) => ({ name: `Takeout/Drive/f${Math.floor(i / 50)}/file-${i}.txt`, data: `content ${i}` }));
    const t1 = await startTestApp({}, undefined, undefined, { dataDir });
    const a = await signIn(t1, 'testuser');
    const dir = stage(t1, a, { 'big.zip': entries });
    const r = await startImport(t1, a, dir, ['big.zip']);
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    const mid = await until(() => jobOf(t1, a, id), (j) => j.done >= 10, 'some entries imported');
    expect(mid.status).toBe('running');
    await t1.close();
    const t2 = await startTestApp({}, undefined, undefined, { dataDir });
    try {
      // Hundreds of fsynced files: give a loaded machine time.
      const done = await until(() => jobOf(t2, a, id), (j) => j.status !== 'running', 'the resumed job', 50_000);
      expect(done).toMatchObject({ status: 'completed', failed: [] });
      const got = tree(join(home(t2, a), dir, 'out'));
      expect(Object.keys(got)).toHaveLength(400);
      for (let i = 0; i < 400; i++) expect(got[`f${Math.floor(i / 50)}/file-${i}.txt`]).toBe(`content ${i}`);
    } finally {
      await t2.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
