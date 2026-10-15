import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { homeRoot } from '../src/paths.ts';
import type { Db } from '../src/db.ts';
import { expireTrash } from '../src/storage/trash.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// A table whose rows hang off a trash row (later: versions kept with a trashed file). Purging must drop them (#112).
const TRASH_TABLES = [{ table: 'test_trash_refs', column: 'trash_id' }] as const;
const prepare = (db: Db) => db.exec('CREATE TABLE test_trash_refs (trash_id TEXT NOT NULL, note TEXT NOT NULL)');

type Session = { cookie: string; csrf: string };
let t: TestApp; let a: Session; let m: Session; let userId: string; let memberId: string; let root: string;
const logLines: string[] = [];
const ORIGIN = 'https://files.example.com';
beforeAll(async () => {
  const logStream = new PassThrough();
  logStream.on('data', (c: Buffer) => logLines.push(...c.toString().split('\n').filter(Boolean)));
  t = await startTestApp({ FILES_LOG_LEVEL: 'error' }, undefined, logStream, { trashTables: TRASH_TABLES, prepare });
  a = await login(t, 'testuser');
  m = await login(t, 'member');
  userId = (await t.app.inject({ url: '/api/v1/me', headers: { cookie: a.cookie } })).json().id;
  memberId = (await t.app.inject({ url: '/api/v1/me', headers: { cookie: m.cookie } })).json().id;
  root = homeRoot(t.config.dataDir, userId);
  mkdirSync(root, { recursive: true });
});
afterAll(() => t.close());

const post = (url: string, payload: unknown, s: Session = a) => t.app.inject({
  method: 'POST', url, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN }, payload: payload as object,
});
const del = (...paths: string[]) => post('/api/v1/sources/home/delete', { paths });
const restore = (id: string, onCollision = 'fail', s: Session = a) => post('/api/v1/trash/restore', { id, onCollision }, s);
const purge = (ids: string[], s: Session = a) => post('/api/v1/trash/delete', { ids }, s);
const empty = (s: Session = a) => post('/api/v1/trash/empty', {}, s);
const listTrash = async (s: Session = a) => (await t.app.inject({ url: '/api/v1/trash', headers: { cookie: s.cookie } })).json();
const download = async (path: string) => (await t.app.inject({
  url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}`, headers: { cookie: a.cookie } }));

let n = 0;
const fresh = (stem: string) => { const d = `/${stem}-${++n}`; mkdirSync(join(root, d), { recursive: true }); return d; };
const put = (path: string, data: string | Buffer, home = root) => {
  mkdirSync(join(home, path, '..'), { recursive: true }); writeFileSync(join(home, path), data);
};
const idOf = (path: string, uid = userId) => (t.db.prepare('SELECT id FROM trash WHERE user_id = ? AND original_path = ? ORDER BY deleted_at DESC')
  .pluck().get(uid, path) as string | undefined)!;
const trashRow = (id: string) => t.db.prepare('SELECT * FROM trash WHERE id = ?').get(id);
const bytesOf = (id: string, home = root) => join(home, '.files', 'trash', id);
const refs = (id: string) => t.db.prepare('SELECT count(*) FROM test_trash_refs WHERE trash_id = ?').pluck().get(id);
const addRef = (id: string) => t.db.prepare("INSERT INTO test_trash_refs VALUES (?, 'kept with the trashed item')").run(id);
const backdate = (id: string, days: number) => t.db.prepare('UPDATE trash SET deleted_at = ? WHERE id = ?')
  .run(new Date(Date.now() - days * 86_400_000).toISOString(), id);
// Bytes on disk under a directory, counted like `du --apparent-size` over regular files.
function du(dir: string): number {
  let sum = 0;
  for (const name of readdirSync(dir)) {
    const st = lstatSync(join(dir, name));
    if (st.isDirectory()) sum += du(join(dir, name)); else if (st.isFile()) sum += st.size;
  }
  return sum;
}
async function trashed(path: string, data: string | Buffer = 'x'): Promise<string> {
  put(path, data);
  expect((await del(path)).statusCode).toBe(204);
  return idOf(path);
}
// A trashed folder whose bytes cannot be removed: its subfolder is read-only, so unlinking the file inside fails.
async function stuck(dir: string): Promise<string> {
  put(`${dir}/Stuck/inner/locked.txt`, 'locked');
  expect((await del(`${dir}/Stuck`)).statusCode).toBe(204);
  const id = idOf(`${dir}/Stuck`);
  chmodSync(join(bytesOf(id), 'inner'), 0o500);
  return id;
}
const unstick = (id: string) => chmodSync(join(bytesOf(id), 'inner'), 0o700);

describe('trash list', () => {
  it('lists name, original path, type, deletion date, size and expiry; a folder counts its whole tree', async () => {
    const d = fresh('list');
    put(`${d}/F/a.txt`, '12345'); put(`${d}/F/sub/b.bin`, Buffer.alloc(1000, 1));
    const fileId = await trashed(`${d}/Bericht ü.txt`, 'hallo');
    expect((await del(`${d}/F`)).statusCode).toBe(204);
    const r = await listTrash();
    const file = r.items.find((i: { id: string }) => i.id === fileId);
    const folder = r.items.find((i: { id: string }) => i.id === idOf(`${d}/F`));
    expect(file).toMatchObject({ name: 'Bericht ü.txt', originalPath: `${d}/Bericht ü.txt`, type: 'file', size: 5 });
    expect(folder).toMatchObject({ name: 'F', originalPath: `${d}/F`, type: 'directory', size: 1005 });
    expect(Date.parse(file.expiresAt) - Date.parse(file.deletedAt)).toBe(30 * 86_400_000);
    expect(r.retentionDays).toBe(30);
  });
  it('shows a member only their own items', async () => {
    const id = await trashed(`${fresh('own')}/mine.txt`);
    expect((await listTrash(m)).items.map((i: { id: string }) => i.id)).not.toContain(id);
    expect((await listTrash()).items.map((i: { id: string }) => i.id)).toContain(id);
  });
});

describe('restore', () => {
  it('puts a file back where it was and drops the row', async () => {
    const d = fresh('restore');
    const id = await trashed(`${d}/back.txt`, 'wieder da');
    const r = await restore(id);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ path: `${d}/back.txt`, type: 'file', size: 9 });
    expect((await download(`${d}/back.txt`)).body).toBe('wieder da');
    expect(trashRow(id)).toBeUndefined();
    expect(existsSync(bytesOf(id))).toBe(false);
  });
  it('recreates missing parent folders', async () => {
    const d = fresh('parents');
    const id = await trashed(`${d}/a/b/c/deep.txt`, 'deep');
    expect((await del(`${d}/a`)).statusCode).toBe(204);
    expect((await restore(id)).statusCode).toBe(200);
    expect((await download(`${d}/a/b/c/deep.txt`)).body).toBe('deep');
  });
  // Regression for #111: restore must never overwrite silently.
  it('with "fail" answers 409 FILE_EXISTS onto a taken name and leaves both files intact', async () => {
    const d = fresh('collide');
    const id = await trashed(`${d}/x.txt`, 'from the trash');
    put(`${d}/x.txt`, 'new file');
    const r = await restore(id);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'x.txt' } });
    expect((await download(`${d}/x.txt`)).body).toBe('new file');
    expect(readFileSync(bytesOf(id), 'utf8')).toBe('from the trash');
    expect(trashRow(id)).toBeDefined();
  });
  it('with "keep-both" restores next to the taken name', async () => {
    const d = fresh('keep');
    const id = await trashed(`${d}/x.txt`, 'old');
    put(`${d}/x.txt`, 'new');
    const r = await restore(id, 'keep-both');
    expect(r.statusCode).toBe(200);
    expect(r.json().path).toBe(`${d}/x (1).txt`);
    expect((await download(`${d}/x.txt`)).body).toBe('new');
    expect((await download(`${d}/x (1).txt`)).body).toBe('old');
    expect(trashRow(id)).toBeUndefined();
  });
  it('with "replace" sends the taken item to the trash instead of destroying it', async () => {
    const d = fresh('replace');
    const id = await trashed(`${d}/x.txt`, 'old');
    put(`${d}/x.txt`, 'new');
    expect((await restore(id, 'replace')).statusCode).toBe(200);
    expect((await download(`${d}/x.txt`)).body).toBe('old');
    expect(readFileSync(bytesOf(idOf(`${d}/x.txt`)), 'utf8')).toBe('new');
  });
  it('refuses another member\'s item and a malformed id', async () => {
    const id = await trashed(`${fresh('foreign')}/x.txt`);
    expect((await restore(id, 'fail', m)).json()).toEqual({ code: 'NOT_FOUND' });
    expect((await purge([id], m)).json()).toEqual({ code: 'NOT_FOUND' });
    expect(existsSync(bytesOf(id))).toBe(true);
    for (const bad of ['../../etc', `${id}/..`, 'x'.repeat(32)]) expect((await restore(bad)).json()).toEqual({ code: 'VALIDATION' });
  });
  it('goes through the resolver: a symlink on the original path is refused and nothing moves', async () => {
    const d = fresh('link');
    const id = await trashed(`${d}/dir/x.txt`, 'x');
    expect((await del(`${d}/dir`)).statusCode).toBe(204);
    symlinkSync('/tmp', join(root, d, 'dir'));
    expect((await restore(id)).json()).toEqual({ code: 'PATH_SYMLINK' });
    expect(readFileSync(bytesOf(id), 'utf8')).toBe('x');
  });
  it('refuses a file where a parent folder was', async () => {
    const d = fresh('notdir');
    const id = await trashed(`${d}/p/x.txt`);
    expect((await del(`${d}/p`)).statusCode).toBe(204);
    put(`${d}/p`, 'now a file');
    expect((await restore(id)).json()).toEqual({ code: 'NOT_A_DIRECTORY' });
    expect(trashRow(id)).toBeDefined();
  });
});

// Single delete, empty trash and expiry are one code path with one rule set: bytes first, then the row and its
// dependent rows in one transaction (#102, #112).
type Way = { way: string; run: (ids: string[]) => Promise<void> };
const WAYS: Way[] = [
  { way: 'single permanent delete', run: async (ids) => { await purge(ids); } },
  { way: 'empty trash', run: async () => { await empty(); } },
  { way: 'expiry', run: async (ids) => { for (const id of ids) backdate(id, 31); await expireTrash(t.app.deps, t.app.log); } },
];

describe('permanent delete', () => {
  it.each(WAYS)('$way removes the bytes, the row and its dependent rows', async ({ run }) => {
    const id = await trashed(`${fresh('purge')}/big.bin`, Buffer.alloc(4096, 2));
    addRef(id);
    await run([id]);
    expect(existsSync(bytesOf(id))).toBe(false);
    expect(trashRow(id)).toBeUndefined();
    expect(refs(id)).toBe(0);
  });
  it.each(WAYS)('$way keeps the row and logs the error when the bytes cannot be removed', async ({ way, run }) => {
    const id = await stuck(fresh('stuck'));
    addRef(id);
    logLines.length = 0;
    try {
      await run([id]);
      expect(trashRow(id), way).toBeDefined();
      expect(refs(id)).toBe(1);
      expect(existsSync(join(bytesOf(id), 'inner', 'locked.txt'))).toBe(true);
      expect(logLines.map((l) => JSON.parse(l)).some((l) => l.trashId === id && l.level >= 50)).toBe(true);
    } finally { unstick(id); }
    // Once the bytes can go, the same item is purged on the next attempt.
    await run([id]);
    expect(trashRow(id)).toBeUndefined();
  });
  it('the request does not report success when an item could not be removed', async () => {
    const id = await stuck(fresh('report'));
    try {
      const single = await purge([id]);
      expect(single.statusCode).toBe(500);
      expect(single.json()).toEqual({ code: 'PURGE_FAILED', params: { count: 1 } });
      expect((await empty()).json()).toEqual({ code: 'PURGE_FAILED', params: { count: 1 } });
      backdate(id, 31);
      const job = await expireTrash(t.app.deps, t.app.log);
      expect(job.failed).toContain(id);
      expect(job.purged).not.toContain(id);
    } finally { unstick(id); await purge([id]); }
  });
  it('a single delete removes only the chosen item; an unknown id changes nothing', async () => {
    const d = fresh('one');
    const keep = await trashed(`${d}/keep.txt`); const drop = await trashed(`${d}/drop.txt`);
    expect((await purge([drop, 'f'.repeat(32)])).json()).toEqual({ code: 'NOT_FOUND' });
    expect(existsSync(bytesOf(drop))).toBe(true);
    expect((await purge([drop])).statusCode).toBe(204);
    expect(existsSync(bytesOf(drop))).toBe(false);
    expect(existsSync(bytesOf(keep))).toBe(true);
  });
  it('empty trash removes all of the member\'s items and nobody else\'s', async () => {
    const mine = await trashed(`${fresh('empty')}/a.txt`);
    const memberRoot = homeRoot(t.config.dataDir, memberId);
    put('/theirs.txt', 'theirs', memberRoot);
    expect((await post('/api/v1/sources/home/delete', { paths: ['/theirs.txt'] }, m)).statusCode).toBe(204);
    const theirs = idOf('/theirs.txt', memberId);
    expect((await empty()).statusCode).toBe(204);
    expect((await listTrash()).items).toEqual([]);
    expect(readdirSync(join(root, '.files', 'trash'))).toEqual([]);
    expect(existsSync(bytesOf(mine))).toBe(false);
    expect(readFileSync(bytesOf(theirs, memberRoot), 'utf8')).toBe('theirs');
  });
});

describe('expiry', () => {
  // Regression for #102: cleanup must free the bytes in the home, not only drop rows.
  it('removes expired items from disk and database; the home\'s disk usage drops by their size', async () => {
    const d = fresh('expire');
    const old = await trashed(`${d}/old.bin`, Buffer.alloc(200_000, 3));
    const recent = await trashed(`${d}/recent.bin`, Buffer.alloc(1000, 4));
    backdate(old, 31); backdate(recent, 29);
    const before = du(root);
    const r = await expireTrash(t.app.deps, t.app.log);
    expect(r.purged).toContain(old);
    expect(r.purged).not.toContain(recent);
    expect(trashRow(old)).toBeUndefined();
    expect(existsSync(bytesOf(old))).toBe(false);
    expect(before - du(root)).toBe(200_000);
    expect(trashRow(recent)).toBeDefined();
    expect(existsSync(bytesOf(recent))).toBe(true);
  });
  it('honours FILES_TRASH_RETENTION_DAYS', async () => {
    const t2 = await startTestApp({ FILES_TRASH_RETENTION_DAYS: '7' });
    try {
      const s = await login(t2);
      const uid = (await t2.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id;
      const home = homeRoot(t2.config.dataDir, uid);
      put('/a.txt', 'a', home);
      const h = { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN };
      expect((await t2.app.inject({ method: 'POST', url: '/api/v1/sources/home/delete', headers: h, payload: { paths: ['/a.txt'] } })).statusCode).toBe(204);
      const id = t2.db.prepare('SELECT id FROM trash').pluck().get() as string;
      t2.db.prepare('UPDATE trash SET deleted_at = ?').run(new Date(Date.now() - 8 * 86_400_000).toISOString());
      expect((await expireTrash(t2.app.deps, t2.app.log)).purged).toEqual([id]);
      expect(existsSync(bytesOf(id, home))).toBe(false);
    } finally { await t2.close(); }
  });
});
