import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, lstatSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Entry } from '@files/shared';
import { homeRoot } from '../src/paths.ts';
import type { ConnectedBackend, StorageBackend } from '../src/storage/backend.ts';
import { AppError } from '../src/errors.ts';
import { rebuildNameIndexes } from '../src/storage/reindex.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// #145: name search. The local index is per member and changes in the same transaction as every write, move, rename
// and delete; the search merges it with every connected backend that implements `search`.

type S = { cookie: string; csrf: string; id: string };
let t: TestApp; let a: S; let m: S;
const ORIGIN = 'https://files.example.com';

// A connected cloud of `testuser` for the merge: one whose search fails, one that finds something, one without search.
const nope = async (): Promise<never> => { throw new Error('not used by the search test'); };
const stub = (search?: StorageBackend['search']): StorageBackend => ({
  list: nope, stat: nope, read: nope, write: nope, mkdir: nope, move: nope, copy: nope, delete: nope,
  ...(search ? { search } : {}),
});
const cloudEntry: Entry = { name: 'cloud-hit.txt', path: '/Docs/cloud-hit.txt', type: 'file', size: 3,
  modified: '2026-10-01T00:00:00.000Z', mime: 'text/plain' };
const connections = async (user: { id: string }): Promise<ConnectedBackend[]> => user.id !== a?.id ? [] : [
  { id: 'broken', backend: stub(async () => { throw new Error('provider exploded'); }) },
  { id: 'throttled', backend: stub(async () => { throw new AppError('UPLOAD_LOCKED'); }) },
  { id: 'works', backend: stub(async (q) => cloudEntry.name.includes(q) ? [cloudEntry] : []) },
  { id: 'nosearch', backend: stub() },
];

beforeAll(async () => {
  t = await startTestApp({ FILES_MAX_UPLOAD_BYTES: String(1024 ** 2) }, undefined, undefined, { connections });
  for (const [user, set] of [['testuser', (s: S) => { a = s; }], ['member', (s: S) => { m = s; }]] as const) {
    const s = await login(t, user);
    const id = (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id as string;
    mkdirSync(homeRoot(t.config.dataDir, id), { recursive: true });
    set({ ...s, id });
  }
});
afterAll(() => t.close());

const mutating = (s: S) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN });
const ok = async (r: Promise<{ statusCode: number; body: string }>) => { const x = await r; expect(x.statusCode, x.body).toBeLessThan(300); return x; };
const post = (op: string, payload: unknown, s: S = a) => ok(t.app.inject({
  method: 'POST', url: `/api/v1/sources/home/${op}`, headers: mutating(s), payload: payload as object }));
const put = (path: string, text: string, s: S = a, onCollision = 'fail') => ok(t.app.inject({ method: 'PUT',
  url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=${onCollision}`,
  headers: { ...mutating(s), 'content-type': 'application/octet-stream' }, payload: Buffer.from(text) }));
const b64 = (v: string) => Buffer.from(v).toString('base64');
const tus = async (path: string, text: string, s: S = a) => {
  const h = { ...mutating(s), 'tus-resumable': '1.0.0' };
  const c = await ok(t.app.inject({ method: 'POST', url: '/api/v1/uploads',
    headers: { ...h, 'upload-length': String(text.length), 'upload-metadata': `source ${b64('home')},path ${b64(path)}` } }));
  await ok(t.app.inject({ method: 'PATCH', url: String((c as unknown as { headers: { location: string } }).headers.location),
    headers: { ...h, 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' }, payload: Buffer.from(text) }));
};
const mkdir = (path: string, s: S = a) => post('mkdir', { path }, s);
const move = (from: string, to: string, onCollision = 'fail') => post('move', { from, to, onCollision });
const copy = (from: string, to: string) => post('copy', { from, to, onCollision: 'fail' });
const del = (...paths: string[]) => post('delete', { paths });
let n = 0;
const fresh = async (stem: string, s: S = a) => { const d = `/${stem}-${++n}`; await mkdir(d, s); return d; };

type Row = { path: string; type: string; name_fold: string };
// The index rows of `s` under `dir` (the folder itself included), as "type path".
const indexed = (dir: string, s: S = a): string[] => (t.db.prepare('SELECT path, type, name_fold FROM name_index WHERE user_id = ?')
  .all(s.id) as Row[]).filter((r) => r.path === dir || r.path.startsWith(dir + '/')).map((r) => {
  // The searchable name is the item's own name, also after a rename.
  expect(r.name_fold, r.path).toBe(r.path.slice(r.path.lastIndexOf('/') + 1).toLowerCase());
  return `${r.type} ${r.path}`;
}).sort();
// What is really on disk under `dir` of `s`'s home.
const onDisk = (dir: string, s: S = a): string[] => {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    const st = lstatSync(abs);
    out.push(`${st.isDirectory() ? 'directory' : 'file'} ${rel}`);
    if (st.isDirectory()) for (const name of readdirSync(abs)) walk(join(abs, name), `${rel}/${name}`);
  };
  walk(join(homeRoot(t.config.dataDir, s.id), dir), dir);
  return out.sort();
};
const matchesDisk = (dir: string, s: S = a) => expect(indexed(dir, s)).toEqual(onDisk(dir, s));

type Group = { source: string; items: Entry[]; more: boolean; error?: { code: string } };
const search = async (q: string, s: S = a): Promise<Group[]> => {
  const r = await t.app.inject({ url: `/api/v1/search?q=${encodeURIComponent(q)}`, headers: { cookie: s.cookie } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().groups;
};
const home = async (q: string, s: S = a) => (await search(q, s)).find((g) => g.source === 'home')!;
const homePaths = async (q: string, s: S = a) => (await home(q, s)).items.map((e) => e.path);

describe('the name index follows every write in the home', () => {
  it('upload (PUT and tus) adds the file and the folders a folder upload created', async () => {
    const d = await fresh('upload');
    await put(`${d}/put.txt`, 'p');
    await tus(`${d}/made/by/upload/tus.txt`, 't');
    matchesDisk(d);
    expect(indexed(d)).toContain(`directory ${d}/made/by`);
  });

  it('mkdir adds the folder', async () => {
    const d = await fresh('mkdir');
    await mkdir(`${d}/sub`);
    matchesDisk(d);
    expect(indexed(d)).toContain(`directory ${d}/sub`);
  });

  it('rename updates the searchable name', async () => {
    const d = await fresh('rename');
    await put(`${d}/before.txt`, 'b');
    await move(`${d}/before.txt`, `${d}/after.txt`);
    matchesDisk(d);
    expect(await homePaths('after.txt')).toEqual([`${d}/after.txt`]);
    expect(await homePaths('before.txt')).not.toContain(`${d}/before.txt`);
  });

  it('a folder move rewrites everything beneath it', async () => {
    const d = await fresh('move');
    await mkdir(`${d}/x`);
    await put(`${d}/x/inner.txt`, 'i');
    await mkdir(`${d}/target`);
    await move(`${d}/x`, `${d}/target/y`);
    matchesDisk(d);
    expect(indexed(d)).toContain(`file ${d}/target/y/inner.txt`);
  });

  it('copy adds the copy and the whole tree beneath a copied folder', async () => {
    const d = await fresh('copy');
    await mkdir(`${d}/src`);
    await put(`${d}/src/deep.txt`, 'd');
    await copy(`${d}/src`, `${d}/dst`);
    await put(`${d}/one.txt`, 'o');
    await copy(`${d}/one.txt`, `${d}/two.txt`);
    matchesDisk(d);
    expect(indexed(d)).toContain(`file ${d}/dst/deep.txt`);
  });

  it('delete removes the item and everything beneath it', async () => {
    const d = await fresh('delete');
    await put(`${d}/gone.txt`, 'g');
    await mkdir(`${d}/f`);
    await put(`${d}/f/deep.txt`, 'd');
    await del(`${d}/gone.txt`, `${d}/f`);
    matchesDisk(d);
    expect(indexed(d)).toEqual([`directory ${d}`]);
  });

  it('replace drops the replaced item and indexes what took its place', async () => {
    const d = await fresh('replace');
    await mkdir(`${d}/old`);
    await put(`${d}/old/inside.txt`, 'i');
    await put(`${d}/new`, 'n');
    await move(`${d}/new`, `${d}/old`, 'replace');
    matchesDisk(d);
    expect(indexed(d)).toContain(`file ${d}/old`);
  });

  it('restore puts a folder and its tree back into the index', async () => {
    const d = await fresh('restore');
    await mkdir(`${d}/back`);
    await put(`${d}/back/kept.txt`, 'k');
    await del(`${d}/back`);
    const trash = (await t.app.inject({ url: '/api/v1/trash', headers: { cookie: a.cookie } })).json();
    const id = trash.items.find((i: { originalPath: string }) => i.originalPath === `${d}/back`).id;
    await ok(t.app.inject({ method: 'POST', url: '/api/v1/trash/restore', headers: mutating(a), payload: { id, onCollision: 'fail' } }));
    matchesDisk(d);
    expect(indexed(d)).toContain(`file ${d}/back/kept.txt`);
  });

  it('the rebuild command replaces a member\'s index with what is on disk', async () => {
    const d = await fresh('rebuild');
    await put(`${d}/known.txt`, 'k');
    await put(`${d}/vanishes.txt`, 'v');
    // Changed outside the app: one file added, one removed, plus the things a listing never shows.
    const root = join(homeRoot(t.config.dataDir, a.id), d);
    writeFileSync(join(root, 'outside.txt'), 'o');
    rmSync(join(root, 'vanishes.txt'));
    writeFileSync(join(root, '.0123456789abcdef.upload'), 'temp');
    const before = indexed(d);
    expect(before).toContain(`file ${d}/vanishes.txt`);
    const memberBefore = indexed('/', m).length;
    await rebuildNameIndexes(t, [a.id]);
    rmSync(join(root, '.0123456789abcdef.upload'));
    matchesDisk(d);
    expect(indexed(d)).toContain(`file ${d}/outside.txt`);
    expect(indexed('/', m).length).toBe(memberBefore);
    // The internal area is never indexed.
    expect(indexed('/.files')).toEqual([]);
  });
});

describe('search', () => {
  it('needs a session and a query', async () => {
    expect((await t.app.inject({ url: '/api/v1/search?q=x' })).statusCode).toBe(401);
    for (const q of ['', '%20%20', 'x'.repeat(201)]) {
      const r = await t.app.inject({ url: `/api/v1/search?q=${q}`, headers: { cookie: a.cookie } });
      expect(r.statusCode, q).toBe(400);
      expect(r.json().code).toBe('VALIDATION');
    }
  });

  it('finds files and folders by part of their name, ignoring case, best matches first', async () => {
    const d = await fresh('find');
    await put(`${d}/Holiday Plan.TXT`, 'h');
    await mkdir(`${d}/holiday`);
    await put(`${d}/my-holiday-photos.zip`, 'z');
    const items = (await home('HOLIDAY')).items.filter((e) => e.path.startsWith(d + '/'));
    expect(items.map((e) => e.path)).toEqual([`${d}/holiday`, `${d}/Holiday Plan.TXT`, `${d}/my-holiday-photos.zip`]);
    expect(items[1]).toMatchObject({ name: 'Holiday Plan.TXT', type: 'file', size: 1, mime: 'text/plain' });
    expect(items[0]).toMatchObject({ name: 'holiday', type: 'directory' });
  });

  it('a member never sees another member\'s files', async () => {
    const d = await fresh('mine');
    await put(`${d}/only-testuser-secret.txt`, 's');
    const md = await fresh('theirs', m);
    await put(`${md}/only-member-secret.txt`, 's', m);
    expect(await homePaths('secret', m)).toEqual([`${md}/only-member-secret.txt`]);
    expect(await homePaths('secret')).toEqual([`${d}/only-testuser-secret.txt`]);
    // The member has no connections; the caller's connected clouds are never searched for them.
    expect((await search('secret', m)).map((g) => g.source)).toEqual(['home']);
  });

  it('treats %, _, brackets and quotes literally', async () => {
    const d = await fresh('literal');
    const names = ['100%.txt', '100x.txt', 'a_b.txt', 'axb.txt', 'it\'s.txt', 'say "hi".txt', '[draft].txt', 'plain.txt'];
    for (const name of names) await put(`${d}/${name}`, 'x');
    const found = async (q: string) => (await homePaths(q)).filter((p) => p.startsWith(d + '/')).map((p) => p.slice(d.length + 1)).sort();
    expect(await found('%')).toEqual(['100%.txt']);
    expect(await found('_')).toEqual(['a_b.txt']);
    expect(await found('a_b')).toEqual(['a_b.txt']);
    expect(await found('\'')).toEqual(['it\'s.txt']);
    expect(await found('"')).toEqual(['say "hi".txt']);
    expect(await found('[d')).toEqual(['[draft].txt']);
    expect(await found('*')).toEqual([]);
    expect(await found('\' OR 1=1 --')).toEqual([]);
  });

  it('reports a failing provider per source and still answers with the local results', async () => {
    const d = await fresh('merge');
    await put(`${d}/cloud-hit.txt`, 'l');
    const groups = await search('cloud-hit');
    expect(groups.map((g) => g.source)).toEqual(['home', 'conn:broken', 'conn:throttled', 'conn:works']);
    expect(groups[0]!.items.map((e) => e.path)).toEqual([`${d}/cloud-hit.txt`]);
    expect(groups[0]!.error).toBeUndefined();
    expect(groups[1]).toEqual({ source: 'conn:broken', items: [], more: false, error: { code: 'SEARCH_FAILED' } });
    expect(groups[2]).toEqual({ source: 'conn:throttled', items: [], more: false, error: { code: 'UPLOAD_LOCKED' } });
    expect(groups[3]).toEqual({ source: 'conn:works', items: [cloudEntry], more: false });
  });

  it('caps each source and says there is more', async () => {
    const d = await fresh('cap');
    for (let i = 0; i < 52; i++) await put(`${d}/many-${i}.txt`, 'x');
    const g = await home('many-');
    expect(g.items).toHaveLength(50);
    expect(g.more).toBe(true);
  });
});
