import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import type { Favourite, FavouriteList } from '@files/shared';
import { homeRoot } from '../src/paths.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { startFakeProvider, type FakeProvider } from './support/fakeProvider.ts';

// #155: favourites across sources. A favourite is a row {member, source, path}; in the home it follows moves and goes
// with a delete in the same transaction (the #137 cascade through PATH_TABLES), in another source it follows the moves
// and deletes made through the app. A favourite of an unlinked connection stays in the list as unavailable and is never
// resolved against another source.

type S = { cookie: string; csrf: string; id: string };
const ORIGIN = 'https://files.example.com';
let t: TestApp; let fake: FakeProvider; let a: S; let m: S;

beforeAll(async () => {
  fake = await startFakeProvider();
  for (const f of ['/Docs/a.txt', '/Docs/b.txt', '/Docs/c.txt', '/top.txt']) fake.put(f, `bytes of ${f}`);
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
const ok = async (r: Promise<{ statusCode: number; body: string }>) => { const x = await r; expect(x.statusCode, x.body).toBeLessThan(300); };
const op = (s: S, source: string, name: string, payload: unknown) => as(s, 'POST', `/api/v1/sources/${source}/${name}`, payload);
const put = async (s: S, path: string, text = 'x', source = 'home') => {
  const r = await t.app.inject({ method: 'PUT', url: `/api/v1/sources/${source}/content?path=${encodeURIComponent(path)}&onCollision=fail`,
    headers: { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf, 'content-type': 'application/octet-stream' }, payload: Buffer.from(text) });
  expect(r.statusCode, r.body).toBe(201);
};
const mkdir = (s: S, path: string, source = 'home') => ok(op(s, source, 'mkdir', { path }));
const move = (s: S, from: string, to: string, source = 'home') => ok(op(s, source, 'move', { from, to, onCollision: 'fail' }));
const del = (s: S, paths: string[], source = 'home') => ok(op(s, source, 'delete', { paths }));
const star = (s: S, source: string, path: string) => as(s, 'POST', '/api/v1/favourites', { source, path });
const starred = async (s: S, source: string, path: string): Promise<Favourite> => {
  const r = await star(s, source, path);
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as Favourite;
};
const favourites = async (s: S): Promise<Favourite[]> => {
  const r = await as(s, 'GET', '/api/v1/favourites');
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as FavouriteList).items;
};
const keys = async (s: S) => (await favourites(s)).map((f) => `${f.source} ${f.path}`);
let n = 0;
const fresh = async (s: S, stem: string) => { const d = `/${stem}-${++n}`; await mkdir(s, d); return d; };

async function connect(s: S): Promise<string> {
  const auth = await as(s, 'POST', '/api/v1/connections/authorize', { provider: 'fake' });
  expect(auth.statusCode, auth.body).toBe(200);
  const back = await fake.consent(auth.json().url as string, { account: 'acct-testuser' });
  const r = await as(s, 'GET', back.pathname + back.search);
  const id = /^\/conn:([0-9a-f]{32})$/.exec(String(r.headers.location))?.[1];
  expect(id, String(r.headers.location)).toBeDefined();
  return id!;
}

describe('favourites', () => {
  it('needs a session and CSRF', async () => {
    expect((await t.app.inject({ url: '/api/v1/favourites' })).statusCode).toBe(401);
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/favourites', headers: { cookie: a.cookie, origin: ORIGIN },
      payload: { source: 'home', path: '/' } });
    expect(r.statusCode).toBe(403);
  });

  it('stars a file and a folder of the home, in the order they were starred, and unstars them', async () => {
    const d = await fresh(a, 'star');
    await put(a, `${d}/note.txt`);
    const folder = await starred(a, 'home', d);
    const file = await starred(a, 'home', `${d}/note.txt`);
    expect(folder).toMatchObject({ source: 'home', path: d, name: d.slice(1), type: 'directory', available: true });
    expect(file).toMatchObject({ source: 'home', path: `${d}/note.txt`, name: 'note.txt', type: 'file', available: true });
    const mine = (await keys(a)).filter((k) => k.includes(d));
    expect(mine).toEqual([`home ${d}`, `home ${d}/note.txt`]);

    // Starring again keeps the one row.
    const again = await star(a, 'home', `${d}/note.txt`);
    expect(again.statusCode).toBe(200);
    expect((again.json() as Favourite).id).toBe(file.id);
    expect((await keys(a)).filter((k) => k.includes(d))).toHaveLength(2);

    expect((await as(a, 'DELETE', `/api/v1/favourites/${file.id}`)).statusCode).toBe(204);
    expect((await keys(a)).filter((k) => k.includes(d))).toEqual([`home ${d}`]);
    expect((await as(a, 'DELETE', `/api/v1/favourites/${file.id}`)).statusCode).toBe(404);
  });

  it('carry a file\'s type, so the list can show its thumbnail; a folder has none (#244)', async () => {
    const d = await fresh(a, 'thumbs');
    await put(a, `${d}/photo.png`);
    await starred(a, 'home', d);
    await starred(a, 'home', `${d}/photo.png`);
    const mine = (await favourites(a)).filter((f) => f.path.startsWith(d));
    expect(mine.find((f) => f.type === 'file')!.mime).toBe('image/png');
    expect(mine.find((f) => f.type === 'directory')).not.toHaveProperty('mime');
  });

  it('refuses what the caller cannot reach: a missing item, an unknown source, another member\'s connection', async () => {
    expect((await star(a, 'home', '/does-not-exist')).json().code).toBe('NOT_FOUND');
    expect((await star(a, 'home', '/')).json().code).toBe('PATH_INVALID');
    expect((await star(a, 'conn:0123456789abcdef0123456789abcdef', '/')).json().code).toBe('SOURCE_NOT_FOUND');
    expect((await star(a, 'nonsense', '/')).json().code).toBe('SOURCE_NOT_FOUND');
    const id = await connect(a);
    const r = await star(m, `conn:${id}`, '/top.txt');
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('SOURCE_NOT_FOUND');
    expect(await keys(m)).not.toContain(`conn:${id} /top.txt`);
    await ok(as(a, 'DELETE', `/api/v1/connections/${id}`));
  });

  it('are per member: another member neither sees nor removes them, and has their own', async () => {
    const d = await fresh(a, 'mine');
    const fav = await starred(a, 'home', d);
    expect(await keys(m)).not.toContain(`home ${d}`);
    expect((await as(m, 'DELETE', `/api/v1/favourites/${fav.id}`)).statusCode).toBe(404);
    expect(await keys(a)).toContain(`home ${d}`);

    // The member's folder of the same name in their own home is their own favourite, not the caller's.
    await mkdir(m, d);
    await starred(m, 'home', d);
    expect((await keys(m)).filter((k) => k === `home ${d}`)).toHaveLength(1);
    await move(m, d, `${d}-moved`);
    expect(await keys(a)).toContain(`home ${d}`); // the member's move does not touch the caller's row
    expect(await keys(m)).toContain(`home ${d}-moved`);
  });

  it('follow a rename, a move and the move of a folder above them', async () => {
    const d = await fresh(a, 'follow');
    await mkdir(a, `${d}/sub`);
    await mkdir(a, `${d}/inner`);
    await put(a, `${d}/inner/deep.txt`);
    await put(a, `${d}/f.txt`);
    await starred(a, 'home', `${d}/f.txt`);
    await starred(a, 'home', `${d}/inner/deep.txt`);

    await move(a, `${d}/f.txt`, `${d}/renamed.txt`);
    await move(a, `${d}/renamed.txt`, `${d}/sub/renamed.txt`);
    await move(a, `${d}/inner`, `${d}/sub/inner`);
    const mine = (await favourites(a)).filter((f) => f.path.startsWith(`${d}/`));
    expect(mine.map((f) => f.path)).toEqual([`${d}/sub/renamed.txt`, `${d}/sub/inner/deep.txt`]);
    expect(mine[0]!.name).toBe('renamed.txt');
  });

  it('go when their item or a folder above it is deleted', async () => {
    const d = await fresh(a, 'gone');
    await mkdir(a, `${d}/f`);
    await put(a, `${d}/f/deep.txt`);
    await put(a, `${d}/single.txt`);
    await put(a, `${d}/stays.txt`);
    await starred(a, 'home', `${d}/f/deep.txt`);
    await starred(a, 'home', `${d}/single.txt`);
    await starred(a, 'home', `${d}/stays.txt`);
    await del(a, [`${d}/single.txt`]);
    await del(a, [`${d}/f`]);
    expect((await keys(a)).filter((k) => k.includes(d))).toEqual([`home ${d}/stays.txt`]);

    // A file restored from the trash is not starred again by itself.
    const trash = (await as(a, 'GET', '/api/v1/trash')).json().items as { id: string; originalPath: string }[];
    await ok(as(a, 'POST', '/api/v1/trash/restore', { id: trash.find((x) => x.originalPath === `${d}/single.txt`)!.id, onCollision: 'fail' }));
    expect(await keys(a)).not.toContain(`home ${d}/single.txt`);
  });

  it('in a cloud connection follow moves and deletes made through the app', async () => {
    const id = await connect(a);
    const src = `conn:${id}`;
    await starred(a, src, '/Docs/a.txt');
    await starred(a, src, '/Docs/b.txt');
    await move(a, '/Docs/a.txt', '/Docs/moved.txt', src);
    await del(a, ['/Docs/b.txt'], src);
    const mine = (await favourites(a)).filter((f) => f.source === src);
    expect(mine.map((f) => [f.path, f.name, f.available])).toEqual([['/Docs/moved.txt', 'moved.txt', true]]);
    await ok(as(a, 'DELETE', `/api/v1/connections/${id}`));
  });

  it('of an unlinked connection are marked unavailable and never resolved against another source', async () => {
    const id = await connect(a);
    const src = `conn:${id}`;
    // The same path exists in the home, so a fallback to the home would find something.
    await mkdir(a, '/Docs');
    await put(a, '/Docs/c.txt', 'home copy');
    await starred(a, src, '/Docs/c.txt');
    await starred(a, src, '/Docs');
    expect((await favourites(a)).filter((f) => f.source === src).every((f) => f.available)).toBe(true);

    await ok(as(a, 'DELETE', `/api/v1/connections/${id}`));
    const after = (await favourites(a)).filter((f) => f.path === '/Docs/c.txt');
    expect(after).toEqual([expect.objectContaining({ source: src, path: '/Docs/c.txt', type: 'file', available: false })]);
    expect((await favourites(a)).find((f) => f.source === src && f.path === '/Docs')?.available).toBe(false);

    // Connecting the same account again is a new source: the old favourites stay unavailable and cannot be starred.
    const again = await connect(a);
    expect(again).not.toBe(id);
    expect((await favourites(a)).filter((f) => f.source === src).map((f) => f.available)).toEqual([false, false]);
    expect((await star(a, src, '/Docs/c.txt')).json().code).toBe('SOURCE_NOT_FOUND');
    // They can still be removed from the list.
    const stale = (await favourites(a)).find((f) => f.source === src && f.path === '/Docs')!;
    expect((await as(a, 'DELETE', `/api/v1/favourites/${stale.id}`)).statusCode).toBe(204);
    await ok(as(a, 'DELETE', `/api/v1/connections/${again}`));
  });

  it('of a share become unavailable once the share is revoked', async () => {
    const d = await fresh(a, 'shared');
    await put(a, `${d}/doc.txt`);
    const share = await as(a, 'POST', '/api/v1/shares', { source: 'home', path: d, grantee: m.id, access: 'read' });
    expect(share.statusCode, share.body).toBe(201);
    const sid = (share.json() as { id: string }).id;
    const fav = await starred(m, `share:${sid}`, '/doc.txt');
    expect(fav).toMatchObject({ source: `share:${sid}`, path: '/doc.txt', available: true });
    expect((await as(a, 'DELETE', `/api/v1/shares/${sid}`)).statusCode).toBe(204);
    expect((await favourites(m)).find((f) => f.id === fav.id)?.available).toBe(false);
  });
});
