import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeRoot } from '../src/paths.ts';
import type { Db } from '../src/db.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// Two path-dependent tables stand in for shares and favourites (#118): the cascade is asserted per table.
const TABLES = [
  { table: 'test_favs', ownerColumn: 'user_id', pathColumn: 'path' },
  { table: 'test_shares', ownerColumn: 'owner_id', pathColumn: 'target' },
] as const;
const prepare = (db: Db) => db.exec(`
  CREATE TABLE test_favs (user_id TEXT NOT NULL, path TEXT NOT NULL);
  CREATE TABLE test_shares (owner_id TEXT NOT NULL, target TEXT NOT NULL);`);

let t: TestApp; let a: { cookie: string; csrf: string }; let userId: string; let root: string;
const ORIGIN = 'https://files.example.com';
beforeAll(async () => {
  t = await startTestApp({}, undefined, undefined, { pathTables: TABLES, prepare });
  a = await login(t, 'testuser');
  userId = (await t.app.inject({ url: '/api/v1/me', headers: { cookie: a.cookie } })).json().id;
  root = homeRoot(t.config.dataDir, userId);
  mkdirSync(root, { recursive: true });
});
afterAll(() => t.close());

const post = (op: string, payload: unknown) => t.app.inject({
  method: 'POST', url: `/api/v1/sources/home/${op}`,
  headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN }, payload: payload as object,
});
const move = (from: string, to: string, onCollision = 'fail') => post('move', { from, to, onCollision });
const copy = (from: string, to: string, onCollision = 'fail') => post('copy', { from, to, onCollision });
const del = (...paths: string[]) => post('delete', { paths });
const list = async (path: string) => (await t.app.inject({
  url: `/api/v1/sources/home/list?path=${encodeURIComponent(path)}`, headers: { cookie: a.cookie } })).json();
const names = async (path: string) => (await list(path)).entries.map((e: { name: string }) => e.name);
const download = async (path: string) => (await t.app.inject({
  url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}`, headers: { cookie: a.cookie } })).rawPayload;

// Every test builds its own tree under a unique folder, so none depends on another one running first.
let n = 0;
const fresh = (stem: string) => { const d = `/${stem}-${++n}`; mkdirSync(join(root, d), { recursive: true }); return d; };
const put = (path: string, data: string | Buffer) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), data); };
// A nested tree with awkward names and binary content; returns its files with their bytes.
function tree(dir: string): Record<string, Buffer> {
  const files: Record<string, Buffer> = {
    'a b.txt': Buffer.from('space'),
    'Prüfung #1 50% & ü.md': Buffer.from('unicode'),
    "sub dir/it's \"quoted\" (1).bin": Buffer.from([0, 1, 2, 255, 254, 10, 13]),
    'sub dir/deeper/🎉.dat': Buffer.alloc(70_000, 7),
  };
  for (const [rel, data] of Object.entries(files)) put(`${dir}/${rel}`, data);
  return files;
}
async function expectTree(dir: string, files: Record<string, Buffer>) {
  for (const [rel, data] of Object.entries(files)) expect(Buffer.compare(await download(`${dir}/${rel}`), data), rel).toBe(0);
}
const rows = (table: (typeof TABLES)[number]) =>
  t.db.prepare(`SELECT ${table.pathColumn} AS p FROM ${table.table} WHERE ${table.ownerColumn} = ? ORDER BY 1`).pluck().all(userId) as string[];
const addRows = (...paths: string[]) => {
  for (const tb of TABLES) for (const p of paths) t.db.prepare(`INSERT INTO ${tb.table} VALUES (?, ?)`).run(userId, p);
};
const trashRows = (path: string) => t.db.prepare('SELECT id, type, size FROM trash WHERE user_id = ? AND original_path = ?').all(userId, path) as
  { id: string; type: string; size: number }[];

describe('rename and move', () => {
  it('renames a file with an awkward name; the bytes are unchanged', async () => {
    const d = fresh('rename');
    put(`${d}/Prüfung #1 50%.txt`, 'hallo');
    const r = await move(`${d}/Prüfung #1 50%.txt`, `${d}/Ergebnis & Notizen (final) 🎉.txt`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ name: 'Ergebnis & Notizen (final) 🎉.txt', path: `${d}/Ergebnis & Notizen (final) 🎉.txt`, type: 'file', size: 5 });
    expect(await names(d)).toEqual(['Ergebnis & Notizen (final) 🎉.txt']);
    expect((await download(`${d}/Ergebnis & Notizen (final) 🎉.txt`)).toString()).toBe('hallo');
  });
  it('moves a nested folder into another folder byte for byte', async () => {
    const d = fresh('move');
    const files = tree(`${d}/Fotos 2026`);
    mkdirSync(join(root, d, 'Archiv'));
    const r = await move(`${d}/Fotos 2026`, `${d}/Archiv/Fotos 2026`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ type: 'directory', path: `${d}/Archiv/Fotos 2026` });
    expect(await names(d)).toEqual(['Archiv']);
    await expectTree(`${d}/Archiv/Fotos 2026`, files);
  });
  it('rejects moving a folder into itself or into its descendant, and leaves it where it was', async () => {
    const d = fresh('self');
    const files = tree(`${d}/A`);
    for (const to of [`${d}/A/A`, `${d}/A/sub dir/A`, `${d}/A/sub dir/deeper/A`]) {
      const r = await move(`${d}/A`, to);
      expect(r.statusCode, to).toBe(409);
      expect(r.json()).toEqual({ code: 'TARGET_INSIDE_SOURCE' });
    }
    await expectTree(`${d}/A`, files);
  });
  it('treats a sibling with a common prefix as a different folder', async () => {
    const d = fresh('prefix');
    mkdirSync(join(root, d, 'A'), { recursive: true }); mkdirSync(join(root, d, 'AB'));
    expect((await move(`${d}/A`, `${d}/AB/A`)).statusCode).toBe(200);
  });
  it('answers FILE_EXISTS with the name, and keeps both or replaces on request', async () => {
    const d = fresh('collide');
    put(`${d}/x.txt`, 'new'); put(`${d}/to/x.txt`, 'old');
    const r = await move(`${d}/x.txt`, `${d}/to/x.txt`);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'x.txt' } });
    expect((await move(`${d}/x.txt`, `${d}/to/x.txt`, 'keep-both')).json().name).toBe('x (1).txt');
    expect((await download(`${d}/to/x (1).txt`)).toString()).toBe('new');
    put(`${d}/x.txt`, 'newer');
    expect((await move(`${d}/x.txt`, `${d}/to/x.txt`, 'replace')).statusCode).toBe(200);
    expect((await download(`${d}/to/x.txt`)).toString()).toBe('newer');
    // The replaced file is not lost: it went to the trash.
    const [old] = trashRows(`${d}/to/x.txt`);
    expect(readFileSync(join(root, '.files', 'trash', old!.id), 'utf8')).toBe('old');
  });
  it('moving onto itself changes nothing', async () => {
    const d = fresh('noop');
    put(`${d}/x.txt`, 'same');
    for (const policy of ['fail', 'keep-both', 'replace']) expect((await move(`${d}/x.txt`, `${d}/x.txt`, policy)).statusCode).toBe(200);
    expect(await names(d)).toEqual(['x.txt']);
    expect(trashRows(`${d}/x.txt`)).toEqual([]);
  });
});

describe('copy', () => {
  it('copies a file; both have the same bytes', async () => {
    const d = fresh('copyfile');
    const data = Buffer.from([0, 255, 1, 254, 0x0a]);
    put(`${d}/bin ä.dat`, data);
    const r = await copy(`${d}/bin ä.dat`, `${d}/Kopie von bin ä.dat`);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: 'Kopie von bin ä.dat', size: 5 });
    expect(Buffer.compare(await download(`${d}/Kopie von bin ä.dat`), data)).toBe(0);
    expect(Buffer.compare(await download(`${d}/bin ä.dat`), data)).toBe(0);
  });
  it('copies a nested folder recursively, byte for byte, and leaves the source alone', async () => {
    const d = fresh('copydir');
    const files = tree(`${d}/Projekt`);
    mkdirSync(join(root, d, 'Ziel'));
    const r = await copy(`${d}/Projekt`, `${d}/Ziel/Projekt`);
    expect(r.statusCode).toBe(201);
    await expectTree(`${d}/Ziel/Projekt`, files);
    await expectTree(`${d}/Projekt`, files);
    expect(await names(`${d}/Ziel/Projekt`)).toEqual(['sub dir', 'a b.txt', 'Prüfung #1 50% & ü.md']);
    // Nothing is left in the staging area.
    expect(readdirSync(join(root, '.files', 'tmp'))).toEqual([]);
  });
  it('copying onto itself with keep-both makes "name (1)"', async () => {
    const d = fresh('dup');
    put(`${d}/x.txt`, 'dup');
    expect((await copy(`${d}/x.txt`, `${d}/x.txt`)).json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'x.txt' } });
    expect((await copy(`${d}/x.txt`, `${d}/x.txt`, 'keep-both')).json().name).toBe('x (1).txt');
    expect((await download(`${d}/x (1).txt`)).toString()).toBe('dup');
  });
  it('rejects copying a folder into its descendant', async () => {
    const d = fresh('copyself');
    tree(`${d}/A`);
    const r = await copy(`${d}/A`, `${d}/A/sub dir/A`);
    expect(r.json()).toEqual({ code: 'TARGET_INSIDE_SOURCE' });
    expect(await names(`${d}/A/sub dir`)).toEqual(['deeper', "it's \"quoted\" (1).bin"]);
  });
  it('a failed copy leaves no half-copied target and no staging leftovers', async () => {
    const d = fresh('copyfail');
    tree(`${d}/A`);
    symlinkSync('/etc', join(root, d, 'A', 'sub dir', 'link'));
    const r = await copy(`${d}/A`, `${d}/B`);
    expect(r.json()).toEqual({ code: 'PATH_SYMLINK' });
    expect(await names(d)).toEqual(['A']);
    expect(readdirSync(join(root, '.files', 'tmp'))).toEqual([]);
  });
});

describe('delete moves to the trash', () => {
  it('moves a file and a nested folder to the trash with one row each', async () => {
    const d = fresh('del');
    put(`${d}/f.txt`, 'bye'); const files = tree(`${d}/F`);
    expect((await del(`${d}/f.txt`, `${d}/F`)).statusCode).toBe(204);
    expect(await names(d)).toEqual([]);
    const [f] = trashRows(`${d}/f.txt`); const [dir] = trashRows(`${d}/F`);
    expect(f).toMatchObject({ type: 'file', size: 3 });
    expect(dir).toMatchObject({ type: 'directory' });
    expect(readFileSync(join(root, '.files', 'trash', f!.id), 'utf8')).toBe('bye');
    for (const [rel, data] of Object.entries(files)) {
      expect(Buffer.compare(readFileSync(join(root, '.files', 'trash', dir!.id, rel)), data)).toBe(0);
    }
  });
  it('is all or nothing: one missing path keeps every item in place', async () => {
    const d = fresh('delall');
    put(`${d}/keep.txt`, 'k');
    const r = await del(`${d}/keep.txt`, `${d}/missing.txt`);
    expect(r.statusCode).toBe(404);
    expect(await names(d)).toEqual(['keep.txt']);
    expect(trashRows(`${d}/keep.txt`)).toEqual([]);
  });
  it('rejects the home itself', async () => {
    expect((await del('/')).json()).toEqual({ code: 'PATH_INVALID' });
  });
});

describe('path-dependent rows cascade (#118)', () => {
  it.each(TABLES)('a single delete removes the rows of the item and beneath it in $table', async (table) => {
    const d = fresh('casc1');
    tree(`${d}/F`); put(`${d}/F2.txt`, 'other');
    addRows(`${d}/F`, `${d}/F/a b.txt`, `${d}/F/sub dir/deeper/🎉.dat`, `${d}/F2.txt`);
    expect((await del(`${d}/F`)).statusCode).toBe(204);
    expect(rows(table).filter((p) => p.startsWith(`${d}/`))).toEqual([`${d}/F2.txt`]);
  });
  it.each(TABLES)('a multi delete removes the rows of every item in $table', async (table) => {
    const d = fresh('cascn');
    put(`${d}/one.txt`, '1'); put(`${d}/two.txt`, '2'); put(`${d}/three.txt`, '3');
    addRows(`${d}/one.txt`, `${d}/two.txt`, `${d}/three.txt`);
    expect((await del(`${d}/one.txt`, `${d}/two.txt`)).statusCode).toBe(204);
    expect(rows(table).filter((p) => p.startsWith(`${d}/`))).toEqual([`${d}/three.txt`]);
  });
  it.each(TABLES)('replacing on move removes the rows of the replaced item in $table and moves the others', async (table) => {
    const d = fresh('cascr');
    put(`${d}/x.txt`, 'new'); put(`${d}/to/x.txt`, 'old');
    addRows(`${d}/x.txt`, `${d}/to/x.txt`);
    expect((await move(`${d}/x.txt`, `${d}/to/x.txt`, 'replace')).statusCode).toBe(200);
    expect(rows(table).filter((p) => p.startsWith(`${d}/`))).toEqual([`${d}/to/x.txt`]);
    expect(t.db.prepare(`SELECT count(*) FROM ${table.table} WHERE ${table.pathColumn} = ?`).pluck().get(`${d}/to/x.txt`)).toBe(1);
  });
  it.each(TABLES)('a move rewrites the rows of the folder and everything beneath it in $table, not a prefix sibling', async (table) => {
    const d = fresh('cascm');
    tree(`${d}/A`); mkdirSync(join(root, d, 'AB')); mkdirSync(join(root, d, 'Z'));
    addRows(`${d}/A`, `${d}/A/a b.txt`, `${d}/A/sub dir/deeper/🎉.dat`, `${d}/AB`);
    expect((await move(`${d}/A`, `${d}/Z/A neu`)).statusCode).toBe(200);
    expect(rows(table).filter((p) => p.startsWith(`${d}/`)).sort()).toEqual(
      [`${d}/AB`, `${d}/Z/A neu`, `${d}/Z/A neu/a b.txt`, `${d}/Z/A neu/sub dir/deeper/🎉.dat`].sort());
  });
  it('a copy leaves the rows of the source alone and adds none', async () => {
    const d = fresh('cascc');
    put(`${d}/x.txt`, 'x'); addRows(`${d}/x.txt`);
    expect((await copy(`${d}/x.txt`, `${d}/y.txt`)).statusCode).toBe(201);
    for (const tb of TABLES) expect(rows(tb).filter((p) => p.startsWith(`${d}/`))).toEqual([`${d}/x.txt`]);
  });
});

// Regression for path traversal: every path goes through resolveInRoot, so nothing outside the home and nothing in
// the internal area can be a source or a target.
describe('paths are resolved inside the home', () => {
  let outside: string;
  beforeAll(() => {
    outside = mkdtempSync(join(tmpdir(), 'files-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
  });
  const bad: [string, string, string][] = [
    ['dot-dot source', '/../../../outside/secret.txt', 'PATH_INVALID'],
    ['dot-dot inside', '/a/../../secret.txt', 'PATH_INVALID'],
    ['backslash', '/..\\..\\secret.txt', 'PATH_INVALID'],
    ['internal area', '/.files', 'PATH_INVALID'],
    ['trash', '/.files/trash', 'PATH_INVALID'],
    ['staging', '/.files/tmp/x', 'PATH_INVALID'],
  ];
  it.each(bad)('rejects a %s as source and as target of move and copy, and for delete', async (_label, p, code) => {
    const d = fresh('trav');
    put(`${d}/ok.txt`, 'ok');
    for (const op of [move, copy]) {
      expect((await op(p, `${d}/stolen.txt`)).json(), `${op.name} from`).toEqual({ code });
      expect((await op(`${d}/ok.txt`, p)).json(), `${op.name} to`).toEqual({ code });
    }
    expect((await del(p)).json()).toEqual({ code });
    expect(await names(d)).toEqual(['ok.txt']);
  });
  it('treats an absolute host path as a path inside the home', async () => {
    const d = fresh('abs');
    put(`${d}/ok.txt`, 'ok');
    expect((await copy(join(outside, 'secret.txt'), `${d}/stolen.txt`)).json()).toEqual({ code: 'NOT_FOUND' });
    expect((await move(`${d}/ok.txt`, join(outside, 'moved.txt'))).json()).toEqual({ code: 'NOT_FOUND' });
    expect(existsSync(join(outside, 'moved.txt'))).toBe(false);
    expect(await names(d)).toEqual(['ok.txt']);
  });
  it('rejects a symlink in the source and in the target path', async () => {
    const d = fresh('link');
    put(`${d}/ok.txt`, 'ok');
    symlinkSync(outside, join(root, d, 'out'));
    expect((await copy(`${d}/out/secret.txt`, `${d}/stolen.txt`)).json()).toEqual({ code: 'PATH_SYMLINK' });
    expect((await move(`${d}/out/secret.txt`, `${d}/stolen.txt`)).json()).toEqual({ code: 'PATH_SYMLINK' });
    expect((await move(`${d}/ok.txt`, `${d}/out/ok.txt`)).json()).toEqual({ code: 'PATH_SYMLINK' });
    expect((await copy(`${d}/ok.txt`, `${d}/out/ok.txt`)).json()).toEqual({ code: 'PATH_SYMLINK' });
    expect((await del(`${d}/out/secret.txt`)).json()).toEqual({ code: 'PATH_SYMLINK' });
    expect(readdirSync(outside)).toEqual(['secret.txt']);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
  });
});
