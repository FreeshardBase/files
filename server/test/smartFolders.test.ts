import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import type { Entry, SmartFolder, SmartFolderList, SmartQuery, SmartResults } from '@files/shared';
import { homeRoot } from '../src/paths.ts';
import { AppError } from '../src/errors.ts';
import type { ConnectedBackend, StorageBackend } from '../src/storage/backend.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { MemBackend } from './support/memBackend.ts';
import { CountingBackend } from './support/countingBackend.ts';

// #214: smart folders, saved structured queries evaluated on open across the home (name index, tags) and the member's
// connections (the provider's search plus a post-filter, or the tagged items). A failing or slow source is a failed group
// next to the others' results, as in global search.

type S = { cookie: string; csrf: string; id: string };
const ORIGIN = 'https://files.example.com';
let t: TestApp; let a: S; let m: S;

// The clouds of `testuser`: one whose search works (a memory backend whose search matches names), one that throws, one
// that is rate-limited, one that never answers, one without search.
const cloud = new MemBackend()
  .put('/Reports/report-big.pdf', 'x'.repeat(5000))
  .put('/Reports/report-small.pdf', 'x')
  .put('/Reports/report-photo.png', 'x'.repeat(5000))
  .put('/Other/tagged.txt', 'tagged');
const searching = Object.assign(cloud, {
  search: async (q: string, limit: number): Promise<Entry[]> => {
    const all = [...cloud.files.keys()].filter((p) => p.split('/').pop()!.toLowerCase().includes(q.toLowerCase()));
    return Promise.all(all.slice(0, limit).map((p) => cloud.stat(p)));
  },
}) as StorageBackend;
const nope = async (): Promise<never> => { throw new Error('not used by the smart folder test'); };
const stub = (search?: StorageBackend['search']): StorageBackend => ({
  list: nope, stat: nope, read: nope, write: nope, mkdir: nope, move: nope, copy: nope, delete: nope,
  ...(search ? { search } : {}),
});
// A cloud whose `stat` counts the calls in flight (#307), with many files to tag.
const counting = new CountingBackend();
const many = Array.from({ length: 510 }, (_, i) => `/many/f${String(i).padStart(3, '0')}.txt`);
for (const f of many) counting.put(f, 'x');
const connections = async (user: { id: string }): Promise<ConnectedBackend[]> => user.id !== a?.id ? [] : [
  { id: 'works', backend: searching },
  { id: 'broken', backend: stub(async () => { throw new Error('provider exploded'); }) },
  { id: 'throttled', backend: stub(async () => { throw new AppError('PROVIDER_UNAVAILABLE'); }) },
  { id: 'slow', backend: stub(() => new Promise<never>(() => {})) },
  { id: 'nosearch', backend: stub() },
  { id: 'counting', backend: counting },
];

beforeAll(async () => {
  t = await startTestApp({ FILES_SOURCE_TIMEOUT_MS: '300' }, undefined, undefined, { connections });
  for (const [user, set] of [['testuser', (s: S) => { a = s; }], ['member', (s: S) => { m = s; }]] as const) {
    const s = await login(t, user);
    const id = (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id as string;
    mkdirSync(homeRoot(t.config.dataDir, id), { recursive: true });
    set({ ...s, id });
  }
});
afterAll(() => t.close());

const as = (s: S, method: string, url: string, payload?: unknown) => t.app.inject({
  method, url, headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': s.csrf }) },
  ...(payload !== undefined ? { payload: payload as object } : {}),
});
const ok = async <R extends { statusCode: number; body: string }>(r: Promise<R>) => { const x = await r; expect(x.statusCode, x.body).toBeLessThan(300); return x; };
const op = (s: S, name: string, payload: unknown) => ok(as(s, 'POST', `/api/v1/sources/home/${name}`, payload));
const put = async (s: S, path: string, text = 'x') => {
  const r = await t.app.inject({ method: 'PUT', url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=fail`,
    headers: { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf, 'content-type': 'application/octet-stream' }, payload: Buffer.from(text) });
  expect(r.statusCode, r.body).toBe(201);
};
const mkdir = (s: S, path: string) => op(s, 'mkdir', { path });
const create = async (s: S, name: string, query: SmartQuery): Promise<SmartFolder> => {
  const r = await as(s, 'POST', '/api/v1/smart-folders', { name, query });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as SmartFolder;
};
const results = async (s: S, id: string): Promise<SmartResults> => {
  const r = await as(s, 'GET', `/api/v1/smart-folders/${id}/results`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as SmartResults;
};
const group = async (s: S, id: string, source = 'home') => (await results(s, id)).groups.find((g) => g.source === source)!;
const paths = async (s: S, id: string, source = 'home') => (await group(s, id, source)).items.map((e) => e.path).sort();
let n = 0;
const fresh = async (s: S, stem: string) => { const d = `/${stem}-${++n}`; await mkdir(s, d); return d; };
const word = (stem: string) => `${stem}${++n}`;

describe('smart folders', () => {
  it('need a session and CSRF', async () => {
    expect((await t.app.inject({ url: '/api/v1/smart-folders' })).statusCode).toBe(401);
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/smart-folders', headers: { cookie: a.cookie, origin: ORIGIN },
      payload: { name: 'x', query: { name: 'x' } } });
    expect(r.statusCode).toBe(403);
  });

  it('are created, listed, edited, renamed and deleted, per member', async () => {
    const f = await create(a, '  Reports  ', { name: 'report', types: ['documents'] });
    expect(f).toMatchObject({ name: 'Reports', query: { name: 'report', types: ['documents'] } });
    expect(((await as(a, 'GET', '/api/v1/smart-folders')).json() as SmartFolderList).items.map((x) => x.id)).toContain(f.id);
    expect(((await as(m, 'GET', '/api/v1/smart-folders')).json() as SmartFolderList).items.map((x) => x.id)).not.toContain(f.id);
    expect((await as(m, 'GET', `/api/v1/smart-folders/${f.id}/results`)).statusCode).toBe(404);
    expect((await as(m, 'PUT', `/api/v1/smart-folders/${f.id}`, { name: 'x', query: { name: 'x' } })).statusCode).toBe(404);
    expect((await as(m, 'DELETE', `/api/v1/smart-folders/${f.id}`)).statusCode).toBe(404);

    const edited = (await ok(as(a, 'PUT', `/api/v1/smart-folders/${f.id}`, { name: 'Old reports', query: { name: 'report', modifiedWithinDays: 30 } }))).json() as SmartFolder;
    expect(edited).toMatchObject({ id: f.id, name: 'Old reports', query: { name: 'report', modifiedWithinDays: 30 } });
    expect(edited.query).not.toHaveProperty('types');
    expect((await as(a, 'DELETE', `/api/v1/smart-folders/${f.id}`)).statusCode).toBe(204);
    expect(((await as(a, 'GET', '/api/v1/smart-folders')).json() as SmartFolderList).items.map((x) => x.id)).not.toContain(f.id);
  });

  it('refuse a query without any criterion, free text in a structured field and a reversed size range', async () => {
    for (const query of [{}, { name: '   ' }, { types: [] }, { regex: '.*' }, { types: ['executables'] }, { sizeMin: 10, sizeMax: 5 },
      { modifiedWithinDays: 0 }, { name: 'x', sources: ['home', 'nonsense'] }]) {
      const r = await as(a, 'POST', '/api/v1/smart-folders', { name: 'bad', query });
      expect(r.statusCode, JSON.stringify(query)).toBe(400);
    }
    expect((await as(a, 'POST', '/api/v1/smart-folders', { name: ' ', query: { name: 'x' } })).statusCode).toBe(400);
  });

  it('change their result when a matching file is added or renamed away', async () => {
    const d = await fresh(a, 'live');
    const key = `zebra${n}`;
    await put(a, `${d}/${key}-1.txt`);
    const f = await create(a, 'Zebras', { name: key, sources: ['home'] });
    expect(await paths(a, f.id)).toEqual([`${d}/${key}-1.txt`]);
    await put(a, `${d}/${key.toUpperCase()}-2.txt`);
    expect(await paths(a, f.id)).toEqual([`${d}/${key}-1.txt`, `${d}/${key.toUpperCase()}-2.txt`].sort());
    await op(a, 'move', { from: `${d}/${key}-1.txt`, to: `${d}/horse.txt`, onCollision: 'fail' });
    expect(await paths(a, f.id)).toEqual([`${d}/${key.toUpperCase()}-2.txt`]);
    // Only the home was asked for.
    expect((await results(a, f.id)).groups.map((g) => g.source)).toEqual(['home']);
  });

  it('change their result when an item is tagged, in the home and in a cloud', async () => {
    const d = await fresh(a, 'tagged');
    await put(a, `${d}/notes.txt`);
    await put(a, `${d}/photo.png`);
    const tag = `Project${n}`;
    const f = await create(a, 'Project docs', { tag, types: ['documents'], sources: ['home', 'conn:works'] });
    expect(await paths(a, f.id)).toEqual([]);
    await ok(as(a, 'POST', '/api/v1/tags/add', { source: 'home', paths: [`${d}/notes.txt`, `${d}/photo.png`], tag }));
    expect(await paths(a, f.id)).toEqual([`${d}/notes.txt`]); // the photo is no document
    // A cloud is scoped by its tagged items, without its search.
    await ok(as(a, 'POST', '/api/v1/tags/add', { source: 'conn:works', paths: ['/Other/tagged.txt'], tag: tag.toLowerCase() }));
    expect(await paths(a, f.id, 'conn:works')).toEqual(['/Other/tagged.txt']);
    await ok(as(a, 'POST', '/api/v1/tags/remove', { source: 'home', paths: [`${d}/notes.txt`], tag }));
    expect(await paths(a, f.id)).toEqual([]);
  });

  it('filter by type, size and modified time, in the home from the index and in a cloud after its search', async () => {
    const d = await fresh(a, 'filters');
    await put(a, `${d}/report-a.pdf`, 'x'.repeat(5000));
    await put(a, `${d}/report-b.pdf`, 'x');
    await put(a, `${d}/report-c.png`, 'x'.repeat(5000));
    await mkdir(a, `${d}/report-folder`);
    await put(a, `${d}/report-old.pdf`, 'x'.repeat(5000));
    // The index says when the app last saw the item; this one is a year old.
    t.db.prepare('UPDATE name_index SET modified = ? WHERE user_id = ? AND path = ?')
      .run(new Date(Date.now() - 365 * 86_400_000).toISOString(), a.id, `${d}/report-old.pdf`);

    const big = await create(a, 'Big documents', { name: 'report', types: ['documents'], sizeMin: 1000, sources: ['home', 'conn:works'] });
    expect((await paths(a, big.id)).filter((p) => p.startsWith(d))).toEqual([`${d}/report-a.pdf`, `${d}/report-old.pdf`]);
    expect(await paths(a, big.id, 'conn:works')).toEqual(['/Reports/report-big.pdf']);

    const recent = await create(a, 'Recent', { name: 'report', modifiedWithinDays: 7, sizeMax: 100, sources: ['home'] });
    expect((await paths(a, recent.id)).filter((p) => p.startsWith(d))).toEqual([`${d}/report-b.pdf`]);

    const folders = await create(a, 'Folders', { name: 'report', types: ['folders', 'images'], sources: ['home'] });
    expect((await paths(a, folders.id)).filter((p) => p.startsWith(d))).toEqual([`${d}/report-c.png`, `${d}/report-folder`]);
  });

  it('show a failing or slow source as failed and still answer the others', async () => {
    const d = await fresh(a, 'failing');
    await put(a, `${d}/report-home.pdf`);
    const f = await create(a, 'Everywhere', { name: 'report' });
    const started = Date.now();
    const r = await results(a, f.id);
    expect(Date.now() - started).toBeLessThan(5000);
    const by = new Map(r.groups.map((g) => [g.source, g]));
    expect([...by.keys()]).toEqual(['home', 'conn:works', 'conn:broken', 'conn:throttled', 'conn:slow', 'conn:nosearch',
      'conn:counting']);
    expect(by.get('home')!.items.map((e) => e.path)).toContain(`${d}/report-home.pdf`);
    expect(by.get('conn:works')!.items.map((e) => e.path).sort())
      .toEqual(['/Reports/report-big.pdf', '/Reports/report-photo.png', '/Reports/report-small.pdf']);
    expect(by.get('conn:broken')).toMatchObject({ items: [], error: { code: 'SEARCH_FAILED' } });
    expect(by.get('conn:throttled')).toMatchObject({ items: [], error: { code: 'PROVIDER_UNAVAILABLE' } });
    expect(by.get('conn:slow')).toMatchObject({ items: [], error: { code: 'SOURCE_TIMEOUT' } });
    expect(by.get('conn:nosearch')).toMatchObject({ items: [], error: { code: 'NOT_SUPPORTED' } });
  });

  it('need a name or a tag to ask a cloud, and name a chosen source that is gone', async () => {
    const f = await create(a, 'Images', { types: ['images'], sources: ['home', 'conn:works', 'conn:unlinked'] });
    const r = await results(a, f.id);
    expect(r.groups.map((g) => [g.source, g.error?.code])).toEqual([
      ['home', undefined], ['conn:works', 'SEARCH_NEEDS_NAME'], ['conn:unlinked', 'SOURCE_NOT_FOUND']]);
  });

  // #307: a tag scoping a cloud stats its tagged items at most 6 at once, and no more than 500 of them.
  it('stat at most 6 tagged items of a cloud at once, and at most 500', async () => {
    const tag = word('many');
    await ok(as(a, 'POST', '/api/v1/tags/add', { source: 'conn:counting', paths: many.slice(0, 50), tag }));
    const f = await create(a, 'Fifty', { tag, sources: ['conn:counting'] });
    counting.reset();
    const g = await group(a, f.id, 'conn:counting');
    expect(g.error).toBeUndefined();
    expect(g.items).toHaveLength(50);
    expect(counting.stats).toBe(50);
    expect(counting.peak).toBe(6);

    const all = word('all');
    await ok(as(a, 'POST', '/api/v1/tags/add', { source: 'conn:counting', paths: many, tag: all }));
    const h = await create(a, 'All', { tag: all, sources: ['conn:counting'] });
    counting.reset();
    const r = await group(a, h.id, 'conn:counting');
    expect(r.error).toBeUndefined();
    expect(r.more).toBe(true);
    expect(counting.stats).toBe(500);
    expect(counting.peak).toBe(6);

    // Fewer matches than a page still say `more` when tagged items were left out.
    const few = await create(a, 'Few', { tag: all, name: 'f00', sources: ['conn:counting'] });
    const fr = await group(a, few.id, 'conn:counting');
    expect(fr.items.map((e) => e.path).sort()).toEqual(many.slice(0, 10));
    expect(fr.more).toBe(true);

    // A cloud that runs out of time starts no further `stat` once nobody waits for it.
    counting.delayMs = 50;
    try {
      counting.reset();
      const slow = await group(a, h.id, 'conn:counting');
      expect(slow.error?.code).toBe('SOURCE_TIMEOUT');
      const atAnswer = counting.stats;
      await new Promise((r) => setTimeout(r, 400));
      expect(counting.stats).toBeLessThanOrEqual(atAnswer + 6);
    } finally { counting.delayMs = undefined; }
  });
});
