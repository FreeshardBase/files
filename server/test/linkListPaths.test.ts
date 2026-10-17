import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Entry, SearchResponse } from '@files/shared';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { startFakeProvider, type FakeProvider } from './support/fakeProvider.ts';

// #291: the share dialog lists an item's public links with `GET /api/v1/links?source&path`, sending the same path it
// created the link with. For every path the UI can hold for an item (from its folder listing, from the search, from a
// stat) and the forms the server normalizes (trailing slash, doubled slash, NFD), the list finds exactly the link that
// create stored, in the home, Google Drive (plain and id-marked names) and Dropbox; and the visitor opens it.

type S = { cookie: string; csrf: string };
type Kind = 'home' | 'drive' | 'dropbox';
const ORIGIN = 'https://files.example.com';
const DIR = '/Linkliste';
const FILE = 'ubuntu-desktop-bootstrap_ubuntu-desktop-bootstrap.desktop';

let t: TestApp; let fake: FakeProvider; let owner: S;
const source: Record<Kind, string> = { home: 'home', drive: '', dropbox: '' };

const as = (method: string, url: string, payload?: unknown) => t.app.inject({ method, url,
  headers: method === 'GET' ? { cookie: owner.cookie } : { cookie: owner.cookie, 'x-csrf-token': owner.csrf, origin: ORIGIN },
  ...(payload !== undefined ? { payload: payload as object } : {}) });
const src = (s: string) => `/api/v1/sources/${encodeURIComponent(s)}`;

async function connect(provider: 'google-drive' | 'dropbox'): Promise<string> {
  const r = await as('POST', '/api/v1/connections/authorize', { provider });
  expect(r.statusCode, r.body).toBe(200);
  const back = await fake.consent(r.json().url as string);
  const cb = await as('GET', back.pathname + back.search);
  const m = /^\/conn:([0-9a-f]{32})$/.exec(String(cb.headers.location));
  expect(m, String(cb.headers.location)).not.toBeNull();
  return `conn:${m![1]!}`;
}
async function put(kind: Kind, path: string, body: string) {
  const r = await t.app.inject({ method: 'PUT', url: `${src(source[kind])}/content?path=${encodeURIComponent(path)}&onCollision=fail`,
    headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, origin: ORIGIN, 'content-type': 'application/octet-stream' },
    payload: Buffer.from(body) });
  expect(r.statusCode, r.body).toBe(201);
}
async function list(kind: Kind, path: string): Promise<Entry[]> {
  const r = await as('GET', `${src(source[kind])}/list?path=${encodeURIComponent(path)}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().entries as Entry[];
}
async function linksAt(kind: Kind, path: string): Promise<string[]> {
  const r = await as('GET', `/api/v1/links?${new URLSearchParams({ source: source[kind], path })}`);
  expect(r.statusCode, r.body).toBe(200);
  return (r.json().items as { id: string }[]).map((l) => l.id);
}

/** Creates a link with `path` as sent, then lists with the same path and with `canonical`; the visitor opens it. */
async function roundTrip(kind: Kind, path: string, canonical: string, name: string) {
  const r = await as('POST', '/api/v1/links', { source: source[kind], path });
  expect(r.statusCode, r.body).toBe(201);
  const { id, token } = r.json() as { id: string; token: string };
  expect(await linksAt(kind, path), `listed with ${JSON.stringify(path)}`).toContain(id);
  expect(await linksAt(kind, canonical), `listed with ${JSON.stringify(canonical)}`).toContain(id);
  const info = await t.app.inject({ url: `/s/${token}/info` });
  expect(info.statusCode, info.body).toBe(200);
  expect(info.json().name).toBe(name);
  expect((await as('DELETE', `/api/v1/links/${id}`)).statusCode).toBe(204);
  expect(await linksAt(kind, canonical)).toEqual([]);
}

beforeAll(async () => {
  fake = await startFakeProvider({ pageSize: 100 }); // one listing page holds the whole test folder
  t = await startTestApp({}, undefined, undefined, { providers: [fake.driveProvider(), fake.dropboxProvider()] });
  owner = await login(t, 'testuser');
  source.drive = await connect('google-drive');
  source.dropbox = await connect('dropbox');
  for (const kind of ['home', 'drive', 'dropbox'] as const) {
    await put(kind, `${DIR}/${FILE}`, '[Desktop Entry]');
    await put(kind, `${DIR}/Fotos/a.txt`, 'a');
    await put(kind, `${DIR}/Café.txt`, 'café');
  }
  // Two Drive items with one name: both are listed with their id in the name (`twice (~<id>).txt`).
  fake.drive.put(`${DIR}/twice.txt`, 'first');
  fake.drive.put(`${DIR}/twice.txt`, 'second');
});
afterAll(async () => { await t.close(); await fake.close(); });

describe.each(['home', 'drive', 'dropbox'] as const)('%s', (kind) => {
  it('every listed item: the listing path, a trailing or doubled slash and NFD all find the created link', async () => {
    const entries = await list(kind, DIR);
    expect(entries.map((e) => e.name)).toEqual(expect.arrayContaining([FILE, 'Fotos', 'Café.txt']));
    for (const e of entries) {
      await roundTrip(kind, e.path, e.path, e.name);
      await roundTrip(kind, e.path.replace(/^\//, '//'), e.path, e.name);
      if (e.type === 'directory') await roundTrip(kind, `${e.path}/`, e.path, e.name);
      if (e.path.normalize('NFD') !== e.path) await roundTrip(kind, e.path.normalize('NFD'), e.path, e.name);
    }
  });

  it('a search result and a stat answer carry the path the list query finds', async () => {
    const r = await as('GET', `/api/v1/search?q=${encodeURIComponent('desktop-bootstrap')}`);
    expect(r.statusCode, r.body).toBe(200);
    const group = (r.json() as SearchResponse).groups.find((g) => g.source === source[kind]);
    const hit = group?.items.find((e) => e.name === FILE);
    expect(hit, JSON.stringify(group)).toBeDefined();
    await roundTrip(kind, hit!.path, `${DIR}/${FILE}`, FILE);
    const st = await as('GET', `${src(source[kind])}/stat?path=${encodeURIComponent(`${DIR}/Fotos`)}`);
    expect(st.statusCode, st.body).toBe(200);
    await roundTrip(kind, (st.json() as Entry).path, `${DIR}/Fotos`, 'Fotos');
  });
});

it('Google Drive: items listed with their id in the name keep it in the link and in the list query', async () => {
  const marked = (await list('drive', DIR)).filter((e) => /^twice \(~[A-Za-z0-9_-]+\)\.txt$/.test(e.name));
  expect(marked).toHaveLength(2);
  for (const e of marked) await roundTrip('drive', e.path, e.path, e.name);
  // One item's link is not listed for its namesake.
  const r = await as('POST', '/api/v1/links', { source: source.drive, path: marked[0]!.path });
  expect(r.statusCode, r.body).toBe(201);
  expect(await linksAt('drive', marked[1]!.path)).toEqual([]);
  expect(await linksAt('drive', marked[0]!.path)).toEqual([r.json().id]);
});
