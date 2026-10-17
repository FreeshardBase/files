import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TAG_COLORS, type TagItemList, type TagList } from '@files/shared';
import { homeRoot } from '../src/paths.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { startFakeProvider, type FakeProvider } from './support/fakeProvider.ts';

// #212: tags on files and folders across sources. A tag is a row {member, source, path, name}, private to its member.
// Home rows follow moves (PATH_TABLES), go to the trash with their item and come back with its restore (TRASH_TABLES);
// in a cloud they follow the moves and deletes made through the app; an item changed elsewhere shows as missing.

type S = { cookie: string; csrf: string; id: string };
const ORIGIN = 'https://files.example.com';
let t: TestApp; let fake: FakeProvider; let a: S; let m: S;

beforeAll(async () => {
  fake = await startFakeProvider();
  for (const f of ['/Docs/a.txt', '/Docs/b.txt', '/top.txt']) fake.put(f, `bytes of ${f}`);
  t = await startTestApp({}, undefined, undefined, { providers: [fake.provider()] });
  for (const [user, set] of [['testuser', (s: S) => { a = s; }], ['member', (s: S) => { m = s; }]] as const) {
    const s = await login(t, user);
    const id = (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id as string;
    mkdirSync(homeRoot(t.config.dataDir, id), { recursive: true });
    set({ ...s, id });
  }
});
afterAll(async () => { await t?.close(); await fake?.close(); });

const as = (s: S, method: string, url: string, payload?: unknown) => t.app.inject({
  method, url, headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': s.csrf }) },
  ...(payload !== undefined ? { payload: payload as object } : {}),
});
const ok = async <R extends { statusCode: number; body: string }>(r: Promise<R>) => { const x = await r; expect(x.statusCode, x.body).toBeLessThan(300); return x; };
const op = (s: S, source: string, name: string, payload: unknown) => as(s, 'POST', `/api/v1/sources/${source}/${name}`, payload);
const put = async (s: S, path: string, text = 'x', source = 'home') => {
  const r = await t.app.inject({ method: 'PUT', url: `/api/v1/sources/${source}/content?path=${encodeURIComponent(path)}&onCollision=fail`,
    headers: { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf, 'content-type': 'application/octet-stream' }, payload: Buffer.from(text) });
  expect(r.statusCode, r.body).toBe(201);
};
const mkdir = (s: S, path: string, source = 'home') => ok(op(s, source, 'mkdir', { path }));
const move = (s: S, from: string, to: string, source = 'home') => ok(op(s, source, 'move', { from, to, onCollision: 'fail' }));
const del = (s: S, paths: string[], source = 'home') => ok(op(s, source, 'delete', { paths }));
const add = (s: S, source: string, paths: string[], tag: string) => as(s, 'POST', '/api/v1/tags/add', { source, paths, tag });
const tagged = async (s: S, source: string, paths: string[], tag: string) => { await ok(add(s, source, paths, tag)); };
const untag = (s: S, source: string, paths: string[], tag: string) => as(s, 'POST', '/api/v1/tags/remove', { source, paths, tag });
const tagsOf = async (s: S, source: string, path: string): Promise<string[]> => {
  const r = await as(s, 'GET', `/api/v1/tags/item?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`);
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { tags: string[] }).tags;
};
const view = async (s: S, name: string): Promise<TagItemList> => {
  const r = await as(s, 'GET', `/api/v1/tags/items?name=${encodeURIComponent(name)}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as TagItemList;
};
const keys = async (s: S, name: string) => (await view(s, name)).items.map((i) => `${i.source} ${i.path} ${i.state}`);
let n = 0;
const fresh = async (s: S, stem: string) => { const d = `/${stem}-${++n}`; await mkdir(s, d); return d; };
const word = (stem: string) => `${stem}${++n}`;

async function connect(s: S): Promise<string> {
  const auth = await as(s, 'POST', '/api/v1/connections/authorize', { provider: 'fake' });
  expect(auth.statusCode, auth.body).toBe(200);
  const back = await fake.consent(auth.json().url as string, { account: 'acct-testuser' });
  const r = await as(s, 'GET', back.pathname + back.search);
  const id = /^\/conn:([0-9a-f]{32})$/.exec(String(r.headers.location))?.[1];
  expect(id, String(r.headers.location)).toBeDefined();
  return id!;
}

describe('tags', () => {
  it('need a session and CSRF', async () => {
    expect((await t.app.inject({ url: '/api/v1/tags' })).statusCode).toBe(401);
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/tags/add', headers: { cookie: a.cookie, origin: ORIGIN },
      payload: { source: 'home', paths: ['/x'], tag: 'x' } });
    expect(r.statusCode).toBe(403);
  });

  it('are added to files and folders, trimmed, unique ignoring case, and the first spelling wins', async () => {
    const d = await fresh(a, 'add');
    await put(a, `${d}/one.txt`);
    await put(a, `${d}/two.txt`);
    const w = word('Work');
    await tagged(a, 'home', [d, `${d}/one.txt`], `  ${w}  `);
    expect(await tagsOf(a, 'home', d)).toEqual([w]);
    // Another spelling of the same tag adds nothing to the item, and names the existing tag elsewhere.
    await tagged(a, 'home', [`${d}/one.txt`], w.toUpperCase());
    await tagged(a, 'home', [`${d}/two.txt`], w.toLowerCase());
    expect(await tagsOf(a, 'home', `${d}/one.txt`)).toEqual([w]);
    expect(await tagsOf(a, 'home', `${d}/two.txt`)).toEqual([w]);
    const list = (await as(a, 'GET', '/api/v1/tags')).json() as TagList;
    expect(list.tags.filter((x) => x.name.toLowerCase() === w.toLowerCase()))
      .toEqual([{ name: w, color: expect.any(String), count: 3 }]);
    expect(TAG_COLORS).toContain(list.tags.find((x) => x.name === w)!.color);

    // The folder's listing gets its children's tags in one request.
    const folder = (await as(a, 'GET', `/api/v1/tags/folder?source=home&path=${encodeURIComponent(d)}`)).json() as { items: { path: string; tags: string[] }[] };
    expect(folder.items.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: `${d}/one.txt`, tags: [w] }, { path: `${d}/two.txt`, tags: [w] }]);

    // Removing takes the tag off the named items only.
    expect((await untag(a, 'home', [`${d}/one.txt`], w.toLowerCase())).statusCode).toBe(204);
    expect(await tagsOf(a, 'home', `${d}/one.txt`)).toEqual([]);
    expect(await tagsOf(a, 'home', `${d}/two.txt`)).toEqual([w]);
  });

  it('refuse names over 40 characters, empty or with control characters, and a 21st tag on an item', async () => {
    const d = await fresh(a, 'limits');
    await put(a, `${d}/f.txt`);
    await tagged(a, 'home', [`${d}/f.txt`], 'ä'.repeat(40));
    for (const bad of ['ä'.repeat(41), '   ', 'a\u0000b', 'a‮b']) {
      const r = await add(a, 'home', [`${d}/f.txt`], bad);
      expect(r.statusCode, bad).toBe(400);
      expect(r.json().code).toMatch(/^(TAG_INVALID|VALIDATION)$/);
    }
    for (let i = 2; i <= 20; i++) await tagged(a, 'home', [`${d}/f.txt`], `t${i}`);
    expect(await tagsOf(a, 'home', `${d}/f.txt`)).toHaveLength(20);
    const r = await add(a, 'home', [`${d}/f.txt`], 'one-too-many');
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'TAG_LIMIT', params: { max: 20 } });
    // A tag it already has is no 21st.
    await tagged(a, 'home', [`${d}/f.txt`], 'T2');

    // "Add tag" on several items is all or nothing.
    await put(a, `${d}/g.txt`);
    expect((await add(a, 'home', [`${d}/g.txt`, `${d}/f.txt`], 'both')).statusCode).toBe(409);
    expect(await tagsOf(a, 'home', `${d}/g.txt`)).toEqual([]);
  });

  it('are private: another member neither sees nor removes them', async () => {
    const d = await fresh(a, 'private');
    const w = word('secret');
    await tagged(a, 'home', [d], w);
    expect((await view(m, w)).items).toEqual([]);
    expect(((await as(m, 'GET', '/api/v1/tags')).json() as TagList).tags.map((x) => x.name)).not.toContain(w);
    expect((await untag(m, 'home', [d], w)).statusCode).toBe(204);
    expect(await tagsOf(a, 'home', d)).toEqual([w]);
  });

  it('follow a rename, a move and the move of a folder above them (home)', async () => {
    const d = await fresh(a, 'follow');
    await mkdir(a, `${d}/sub`);
    await mkdir(a, `${d}/inner`);
    await put(a, `${d}/inner/deep.txt`);
    await put(a, `${d}/f.txt`);
    const w = word('follow');
    await tagged(a, 'home', [`${d}/f.txt`, `${d}/inner/deep.txt`], w);
    await move(a, `${d}/f.txt`, `${d}/renamed.txt`);
    await move(a, `${d}/renamed.txt`, `${d}/sub/renamed.txt`);
    await move(a, `${d}/inner`, `${d}/sub/inner`);
    expect((await keys(a, w)).sort()).toEqual([`home ${d}/sub/inner/deep.txt ok`, `home ${d}/sub/renamed.txt ok`]);
    expect((await view(a, w)).items.find((i) => i.path.endsWith('renamed.txt'))).toMatchObject({ name: 'renamed.txt', type: 'file',
      entry: { name: 'renamed.txt', path: `${d}/sub/renamed.txt`, size: 1 } });
  });

  it('go to the trash with their item, come back with its restore and are purged with it', async () => {
    const d = await fresh(a, 'trash');
    await mkdir(a, `${d}/f`);
    await put(a, `${d}/f/deep.txt`);
    await put(a, `${d}/single.txt`);
    await put(a, `${d}/stays.txt`);
    const w = word('trash');
    await tagged(a, 'home', [`${d}/f`, `${d}/f/deep.txt`, `${d}/single.txt`, `${d}/stays.txt`], w);
    await del(a, [`${d}/single.txt`]);
    await del(a, [`${d}/f`]);
    expect(await keys(a, w)).toEqual([`home ${d}/stays.txt ok`]);
    expect(await tagsOf(a, 'home', `${d}/single.txt`)).toEqual([]);

    // A new item under the old name is untagged, and may be tagged while the old one waits in the trash.
    await put(a, `${d}/single.txt`, 'new');
    expect(await tagsOf(a, 'home', `${d}/single.txt`)).toEqual([]);
    await move(a, `${d}/single.txt`, `${d}/other.txt`);

    const trash = (await as(a, 'GET', '/api/v1/trash')).json().items as { id: string; originalPath: string }[];
    const idOf = (p: string) => trash.find((x) => x.originalPath === p)!.id;
    await ok(as(a, 'POST', '/api/v1/trash/restore', { id: idOf(`${d}/f`), onCollision: 'fail' }));
    expect((await keys(a, w)).sort()).toEqual([`home ${d}/f ok`, `home ${d}/f/deep.txt ok`, `home ${d}/stays.txt ok`]);
    expect(await tagsOf(a, 'home', `${d}/f/deep.txt`)).toEqual([w]);

    // Purging the other item takes its tags for good.
    await ok(as(a, 'POST', '/api/v1/trash/delete', { ids: [idOf(`${d}/single.txt`)] }));
    const rows = t.db.prepare('SELECT count(*) FROM tags WHERE user_id = ? AND path = ?').pluck().get(a.id, `${d}/single.txt`);
    expect(rows).toBe(0);
  });

  it('a restore that keeps both takes the tags to the new name', async () => {
    const d = await fresh(a, 'keep');
    await put(a, `${d}/k.txt`);
    const w = word('keep');
    await tagged(a, 'home', [`${d}/k.txt`], w);
    await del(a, [`${d}/k.txt`]);
    await put(a, `${d}/k.txt`, 'in the way');
    const trash = (await as(a, 'GET', '/api/v1/trash')).json().items as { id: string; originalPath: string }[];
    await ok(as(a, 'POST', '/api/v1/trash/restore', { id: trash.find((x) => x.originalPath === `${d}/k.txt`)!.id, onCollision: 'keep-both' }));
    expect(await keys(a, w)).toEqual([`home ${d}/k (1).txt ok`]);
  });

  it('left by a change outside the app show as missing, and give way to a move onto their path', async () => {
    const d = await fresh(a, 'outside');
    await put(a, `${d}/gone.txt`);
    await put(a, `${d}/mover.txt`);
    const w = word('stale');
    await tagged(a, 'home', [`${d}/gone.txt`], w);
    rmSync(join(homeRoot(t.config.dataDir, a.id), d, 'gone.txt'));
    expect(await keys(a, w)).toEqual([`home ${d}/gone.txt missing`]);
    // Another file moved onto the free name does not inherit the stale tag.
    await move(a, `${d}/mover.txt`, `${d}/gone.txt`);
    expect(await keys(a, w)).toEqual([]);
    expect(await tagsOf(a, 'home', `${d}/gone.txt`)).toEqual([]);
  });

  it('in a cloud connection follow moves and deletes made through the app; unlinked: unavailable', async () => {
    const id = await connect(a);
    const src = `conn:${id}`;
    const w = word('cloud');
    const d = await fresh(a, 'mixed');
    await put(a, `${d}/home.txt`);
    await tagged(a, 'home', [`${d}/home.txt`], w);
    await tagged(a, src, ['/Docs/a.txt', '/Docs/b.txt'], w);
    await move(a, '/Docs/a.txt', '/Docs/moved.txt', src);
    await del(a, ['/Docs/b.txt'], src);
    expect(await tagsOf(a, src, '/Docs/moved.txt')).toEqual([w]);
    // The tag view lists the items of both sources.
    expect((await keys(a, w)).sort()).toEqual([`${src} /Docs/moved.txt ok`, `home ${d}/home.txt ok`].sort());

    await tagged(a, src, ['/top.txt'], w);
    await ok(as(a, 'DELETE', `/api/v1/connections/${id}`));
    expect((await keys(a, w)).sort()).toEqual([`${src} /Docs/moved.txt unavailable`, `${src} /top.txt unavailable`,
      `home ${d}/home.txt ok`].sort());
    // They can still be removed.
    expect((await untag(a, src, ['/top.txt'], w)).statusCode).toBe(204);
    expect(await keys(a, w)).not.toContain(`${src} /top.txt unavailable`);
  });

  it('need edit access: a read share refuses, an edit share tags', async () => {
    const d = await fresh(a, 'shared');
    await put(a, `${d}/doc.txt`);
    const read = (await ok(as(a, 'POST', '/api/v1/shares', { source: 'home', path: d, grantee: m.id, access: 'read' }))).json() as { id: string };
    const r = await add(m, `share:${read.id}`, ['/doc.txt'], 'nope');
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('FORBIDDEN');
    await ok(as(a, 'DELETE', `/api/v1/shares/${read.id}`));

    const edit = (await ok(as(a, 'POST', '/api/v1/shares', { source: 'home', path: d, grantee: m.id, access: 'edit' }))).json() as { id: string };
    const w = word('grantee');
    await tagged(m, `share:${edit.id}`, ['/doc.txt'], w);
    expect(await keys(m, w)).toEqual([`share:${edit.id} /doc.txt ok`]);
    // The owner's own tags are not the grantee's.
    expect(await tagsOf(a, 'home', `${d}/doc.txt`)).toEqual([]);
    // A missing item, the root and an unknown source are refused.
    expect((await add(m, `share:${edit.id}`, ['/nothing.txt'], w)).json().code).toBe('NOT_FOUND');
    expect((await add(a, 'home', ['/'], w)).json().code).toBe('PATH_INVALID');
    expect((await add(a, 'conn:0123456789abcdef0123456789abcdef', ['/x'], w)).json().code).toBe('SOURCE_NOT_FOUND');
  });
});
