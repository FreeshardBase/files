import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { homeRoot } from '../src/paths.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { startFakeProvider, type FakeProvider } from './support/fakeProvider.ts';

// #208: the sharing matrix. Internal shares ({file, folder} × {read, edit}) and public links (file, folder) on every
// source: the home, Google Drive (`fake.drive`) and Dropbox (`fake.dropbox`), each reached through the owner's real
// connection. The grantee and the visitor only ever talk to the shard: no provider URL, token or redirect reaches them,
// and writes through an edit share land in the owner's cloud. Edge cases: an unlinked connection (410) and an item
// renamed at the provider (404, DECISIONS 2026-10-15 #208).

type S = { cookie: string; csrf: string };
type Kind = 'home' | 'drive' | 'dropbox';
const KINDS: Kind[] = ['home', 'drive', 'dropbox'];
const ORIGIN = 'https://files.example.com';

let t: TestApp; let fake: FakeProvider; let owner: S; let grantee: S;
let ownerId = ''; let granteeId = '';
const conn: Record<Kind, string> = { home: 'home', drive: '', dropbox: '' };
let png: Buffer;

const mutating = (s: S) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN });
const as = (s: S, method: string, url: string, payload?: unknown) => t.app.inject({ method, url,
  headers: method === 'GET' ? { cookie: s.cookie } : mutating(s), ...(payload !== undefined ? { payload: payload as object } : {}) });
const ok = async <R extends { statusCode: number; body: string }>(r: Promise<R>) => {
  const x = await r; expect(x.statusCode, x.body).toBeLessThan(300); return x;
};

async function connect(provider: 'google-drive' | 'dropbox', account?: string): Promise<string> {
  const r = await as(owner, 'POST', '/api/v1/connections/authorize', { provider });
  expect(r.statusCode, r.body).toBe(200);
  const back = await fake.consent(r.json().url as string, account ? { account } : {});
  const cb = await as(owner, 'GET', back.pathname + back.search);
  const m = /^\/conn:([0-9a-f]{32})$/.exec(String(cb.headers.location));
  expect(m, String(cb.headers.location)).not.toBeNull();
  return `conn:${m![1]!}`;
}

beforeAll(async () => {
  fake = await startFakeProvider({ pageSize: 2 });
  t = await startTestApp({ FILES_MAX_UPLOAD_BYTES: String(1024 ** 2) }, undefined, undefined,
    { providers: [fake.driveProvider(), fake.dropboxProvider()] });
  owner = await login(t, 'testuser'); grantee = await login(t, 'member');
  ownerId = (await as(owner, 'GET', '/api/v1/me')).json().id;
  granteeId = (await as(grantee, 'GET', '/api/v1/me')).json().id;
  conn.drive = await connect('google-drive');
  conn.dropbox = await connect('dropbox');
  png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#3a6' } }).png().toBuffer();
});
afterAll(async () => { await t.close(); await fake.close(); });
afterEach(() => { vi.useRealTimers(); });

const src = (source: string) => `/api/v1/sources/${encodeURIComponent(source)}`;
const q = (path: string) => `path=${encodeURIComponent(path)}`;
const put = (s: S, source: string, path: string, body: string | Buffer, onCollision = 'fail') => t.app.inject({
  method: 'PUT', url: `${src(source)}/content?${q(path)}&onCollision=${onCollision}`,
  headers: { ...mutating(s), 'content-type': 'application/octet-stream' }, payload: Buffer.from(body) });
const op = (s: S, source: string, name: string, payload: unknown) => as(s, 'POST', `${src(source)}/${name}`, payload);
const get = (s: S, source: string, name: string, path: string, headers: Record<string, string> = {}) =>
  t.app.inject({ url: `${src(source)}/${name}?${q(path)}`, headers: { cookie: s.cookie, ...headers } });

/** What the owner's store holds at `path`, read from the store itself (disk or the fake provider), or undefined. */
function stored(kind: Kind, path: string): string | undefined {
  if (kind === 'home') {
    const p = join(homeRoot(t.config.dataDir, ownerId), path);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  }
  if (kind === 'drive') {
    const f = fake.drive.byPath(path);
    return f ? fake.drive.bytes(f.id).toString() : undefined;
  }
  return fake.dropbox.byPath(path) ? fake.dropbox.bytes(path).toString() : undefined;
}
const storedFolder = (kind: Kind, path: string) => kind === 'home' ? existsSync(join(homeRoot(t.config.dataDir, ownerId), path))
  : kind === 'drive' ? fake.drive.byPath(path) !== undefined : fake.dropbox.byPath(path)?.folder === true;

/**
 * The answer came from the shard: no redirect, and neither the provider's address nor any token the shard used at the
 * provider appears in its headers or body.
 */
function fromShard(r: { statusCode: number; headers: Record<string, unknown>; body: string }) {
  expect(r.headers.location, r.body).toBeUndefined();
  expect(r.statusCode).not.toBe(302);
  const text = JSON.stringify(r.headers) + r.body;
  const host = new URL(fake.url).host;
  expect(text).not.toContain(host);
  for (const token of new Set(fake.requests.map((x) => x.token).filter((x): x is string => !!x))) expect(text).not.toContain(token);
}

let n = 0;
/** A fresh folder `/m<n>` in the owner's `kind` with `note.txt`, `photo.png` and `sub/deep.txt`, made through the owner's API. */
async function seedFolder(kind: Kind): Promise<string> {
  const dir = `/m${++n}-${kind}`;
  await ok(op(owner, conn[kind], 'mkdir', { path: dir }));
  await ok(put(owner, conn[kind], `${dir}/note.txt`, 'hello from the owner'));
  await ok(put(owner, conn[kind], `${dir}/photo.png`, png));
  await ok(put(owner, conn[kind], `${dir}/sub/deep.txt`, 'deep down'));
  await ok(put(owner, conn[kind], `${dir}-outside.txt`, 'owner private'));
  expect(stored(kind, `${dir}/note.txt`)).toBe('hello from the owner');
  return dir;
}
async function seedFile(kind: Kind, text = 'just this one'): Promise<string> {
  const path = `/f${++n}-${kind}.txt`;
  await ok(put(owner, conn[kind], path, text));
  return path;
}
async function share(kind: Kind, path: string, access: 'read' | 'edit'): Promise<string> {
  const r = await as(owner, 'POST', '/api/v1/shares', { source: conn[kind], path, grantee: granteeId, access });
  expect(r.statusCode, r.body).toBe(201);
  return `share:${r.json().id as string}`;
}
async function link(kind: Kind, path: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await as(owner, 'POST', '/api/v1/links', { source: conn[kind], path, ...extra });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().token as string;
}
const visit = (token: string, rest: string, o: { cookie?: string; headers?: Record<string, string> } = {}) =>
  t.app.inject({ url: `/s/${token}/${rest}`, remoteAddress: '198.51.100.7',
    headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers } });
const unlock = (token: string, password: string) => t.app.inject({ method: 'POST', url: `/s/${token}/unlock`,
  remoteAddress: '198.51.100.7', headers: { origin: ORIGIN }, payload: { password } });
type Page = { statusCode: number; body: string; headers: Record<string, unknown>;
  json(): { entries: { name: string }[]; next?: string } };
/** Every name in a folder, following `next` (Dropbox hands its pages through one per request); each page from the shard. */
async function names(first: Page, more: (cursor: string) => Promise<Page>): Promise<string[]> {
  const all: string[] = [];
  for (let r = first; ; r = await more(r.json().next!)) {
    expect(r.statusCode, r.body).toBe(200);
    fromShard(r);
    all.push(...r.json().entries.map((e) => e.name));
    if (!r.json().next) return all.sort();
  }
}
const ownerNames = async (kind: Kind, path: string) => names(await get(owner, conn[kind], 'list', path),
  (c) => t.app.inject({ url: `${src(conn[kind])}/list?${q(path)}&cursor=${encodeURIComponent(c)}`, headers: { cookie: owner.cookie } }));
const shareNames = async(s: string, path: string) => names(await get(grantee, s, 'list', path),
  (c) => t.app.inject({ url: `${src(s)}/list?${q(path)}&cursor=${encodeURIComponent(c)}`, headers: { cookie: grantee.cookie } }));
const linkNames = async (token: string, path: string) => names(await visit(token, `list?${q(path)}`),
  (c) => visit(token, `list?${q(path)}&cursor=${encodeURIComponent(c)}`));

describe.each(KINDS)('internal share on %s', (kind) => {
  it('read folder: the grantee lists, downloads and previews through the shard; every write is 403 and changes nothing', async () => {
    const dir = await seedFolder(kind);
    const s = await share(kind, dir, 'read');
    const list = await get(grantee, s, 'list', '/');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().access).toBe('read');
    expect(await shareNames(s, '/')).toEqual(['note.txt', 'photo.png', 'sub']);
    expect(await shareNames(s, '/sub')).toEqual(['deep.txt']);
    const dl = await get(grantee, s, 'content', '/note.txt');
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('hello from the owner');
    fromShard(dl);
    const ranged = await get(grantee, s, 'content', '/note.txt', { range: 'bytes=6-9' });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.body).toBe('from');
    const preview = await get(grantee, s, 'content', '/photo.png');
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toBe('image/png');
    expect(preview.headers['content-disposition']).toMatch(/^inline;/);
    expect(preview.rawPayload.equals(png)).toBe(true);
    fromShard(preview);
    // Nothing above the shared folder can be named.
    expect((await get(grantee, s, 'content', `/..${dir}-outside.txt`)).body).not.toContain('owner private');
    expect((await get(grantee, s, 'list', '/..')).statusCode).toBe(400);

    for (const r of [
      await put(grantee, s, '/new.txt', 'x'),
      await put(grantee, s, '/note.txt', 'overwritten', 'replace'),
      await op(grantee, s, 'mkdir', { path: '/newdir' }),
      await op(grantee, s, 'move', { from: '/note.txt', to: '/renamed.txt', onCollision: 'fail' }),
      await op(grantee, s, 'copy', { from: '/note.txt', to: '/copy.txt', onCollision: 'fail' }),
      await op(grantee, s, 'delete', { paths: ['/note.txt'] }),
    ]) {
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json()).toEqual({ code: 'FORBIDDEN' });
    }
    expect(stored(kind, `${dir}/note.txt`)).toBe('hello from the owner');
    for (const p of ['new.txt', 'renamed.txt', 'copy.txt']) expect(stored(kind, `${dir}/${p}`), p).toBeUndefined();
    expect(storedFolder(kind, `${dir}/newdir`)).toBe(false);
  });

  it('edit folder: upload, mkdir, rename, copy and delete land in the owner\'s store through the owner\'s connection', async () => {
    const dir = await seedFolder(kind);
    const s = await share(kind, dir, 'edit');
    expect((await get(grantee, s, 'list', '/')).json().access).toBe('edit');
    const up = await put(grantee, s, '/from-member.txt', 'written by the grantee');
    expect(up.statusCode, up.body).toBe(201);
    fromShard(up);
    expect(stored(kind, `${dir}/from-member.txt`)).toBe('written by the grantee');
    await ok(op(grantee, s, 'mkdir', { path: '/made' }));
    expect(storedFolder(kind, `${dir}/made`)).toBe(true);
    await ok(op(grantee, s, 'move', { from: '/note.txt', to: '/made/renamed.txt', onCollision: 'fail' }));
    expect(stored(kind, `${dir}/note.txt`)).toBeUndefined();
    expect(stored(kind, `${dir}/made/renamed.txt`)).toBe('hello from the owner');
    await ok(op(grantee, s, 'copy', { from: '/sub/deep.txt', to: '/made/deep-copy.txt', onCollision: 'fail' }));
    expect(stored(kind, `${dir}/made/deep-copy.txt`)).toBe('deep down');
    expect(stored(kind, `${dir}/sub/deep.txt`)).toBe('deep down');
    await ok(op(grantee, s, 'delete', { paths: ['/from-member.txt'] }));
    expect(stored(kind, `${dir}/from-member.txt`)).toBeUndefined();
    // Nothing escapes the shared folder, and the shared folder itself is not the grantee's to move or delete.
    expect((await put(grantee, s, '/../escaped.txt', 'x')).statusCode).toBe(400);
    expect(stored(kind, '/escaped.txt')).toBeUndefined();
    expect((await op(grantee, s, 'delete', { paths: ['/'] })).statusCode).toBe(403);
    expect(storedFolder(kind, dir)).toBe(true);
  });

  it('edit folder: a write at `/` is 403 with every policy and leaves the shared folder in place (#252)', async () => {
    const dir = await seedFolder(kind);
    const s = await share(kind, dir, 'edit');
    for (const root of ['/', '//']) {
      for (const policy of ['replace', 'keep-both', 'fail']) {
        const w = await put(grantee, s, root, 'planted by the grantee', policy);
        expect(w.statusCode, `${root} ${policy}: ${w.body}`).toBe(403);
        expect(w.json().code).toBe('FORBIDDEN');
        fromShard(w);
      }
    }
    expect(storedFolder(kind, dir)).toBe(true);
    expect(stored(kind, `${dir}/note.txt`)).toBe('hello from the owner');
    expect(await ownerNames(kind, '/')).not.toContain(`${dir.slice(1)} (1)`);
  });

  it('read file: the grantee downloads the file at `/`; overwriting is 403', async () => {
    const path = await seedFile(kind);
    const s = await share(kind, path, 'read');
    const dl = await get(grantee, s, 'content', '/');
    expect(dl.statusCode, dl.body).toBe(200);
    expect(dl.body).toBe('just this one');
    expect(String(dl.headers['content-disposition'])).toContain(path.slice(1));
    fromShard(dl);
    const w = await put(grantee, s, '/', 'changed', 'replace');
    expect(w.statusCode).toBe(403);
    expect(stored(kind, path)).toBe('just this one');
  });

  it('edit file: the grantee overwrites the file in the owner\'s store, but cannot rename or delete it', async () => {
    const path = await seedFile(kind);
    const s = await share(kind, path, 'edit');
    const w = await put(grantee, s, '/', 'changed by the grantee', 'replace');
    expect(w.statusCode, w.body).toBe(201);
    expect(stored(kind, path)).toBe('changed by the grantee');
    expect((await get(grantee, s, 'content', '/')).body).toBe('changed by the grantee');
    expect((await op(grantee, s, 'move', { from: '/', to: '/elsewhere.txt', onCollision: 'fail' })).statusCode).toBe(403);
    expect((await op(grantee, s, 'delete', { paths: ['/'] })).statusCode).toBe(403);
    expect(stored(kind, path)).toBe('changed by the grantee');
  });

  it('edit file: `/` with keep-both or fail plants nothing beside the file in the owner\'s store (#252)', async () => {
    const path = await seedFile(kind);
    const s = await share(kind, path, 'edit');
    const before = await ownerNames(kind, '/');
    for (const root of ['/', '//']) {
      const kb = await put(grantee, s, root, 'planted by the grantee', 'keep-both');
      expect(kb.statusCode, `${root}: ${kb.body}`).toBe(403);
      expect(kb.json().code).toBe('FORBIDDEN');
      fromShard(kb);
    }
    const fail = await put(grantee, s, '/', 'planted by the grantee', 'fail');
    expect(fail.statusCode, fail.body).toBe(409);
    expect(await ownerNames(kind, '/')).toEqual(before);
    expect(stored(kind, path)).toBe('just this one');
  });
});

describe.each(KINDS)('public link on %s', (kind) => {
  it('folder: the visitor browses into a subfolder, downloads, uses Range and preview, and never gets above it', async () => {
    const dir = await seedFolder(kind);
    const token = await link(kind, dir);
    const info = await visit(token, 'info');
    expect(info.json()).toMatchObject({ name: dir.slice(1), type: 'directory', locked: false });
    expect(await linkNames(token, '/')).toEqual(['note.txt', 'photo.png', 'sub']);
    expect(await linkNames(token, '/sub')).toEqual(['deep.txt']);
    const deep = await visit(token, `content?${q('/sub/deep.txt')}`);
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toBe('deep down');
    expect(deep.headers['content-disposition']).toMatch(/^attachment;/);
    fromShard(deep);
    const ranged = await visit(token, `content?${q('/note.txt')}`, { headers: { range: 'bytes=0-4' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.body).toBe('hello');
    fromShard(ranged);
    const preview = await visit(token, `content?${q('/photo.png')}&inline=1`);
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-disposition']).toMatch(/^inline;/);
    expect(preview.rawPayload.equals(png)).toBe(true);
    fromShard(preview);
    for (const p of ['/..', '/sub/../..', '../']) expect((await visit(token, `list?${q(p)}`)).statusCode, p).toBe(400);
    for (const p of [`/..${dir}-outside.txt`, `${dir}-outside.txt`]) {
      const r = await visit(token, `content?${q(p)}`);
      expect(r.statusCode, p).toBeGreaterThanOrEqual(400);
      expect(r.body, p).not.toContain('owner private');
    }
  });

  it('file with password and limit 1: locked until unlocked, then exactly one download', async () => {
    const path = await seedFile(kind, 'secret bytes');
    const token = await link(kind, path, { password: 'correct horse', maxDownloads: 1 });
    expect((await visit(token, 'info')).json()).toMatchObject({ locked: true });
    const locked = await visit(token, 'content');
    expect(locked.json()).toEqual({ code: 'PASSWORD_REQUIRED' });
    expect(locked.body).not.toContain('secret bytes');
    expect((await unlock(token, 'wrong')).json()).toEqual({ code: 'PASSWORD_WRONG' });
    const u = await unlock(token, 'correct horse');
    expect(u.statusCode).toBe(204);
    const cookie = String(u.headers['set-cookie']).split(';')[0]!;
    const dl = await visit(token, 'content', { cookie });
    expect(dl.statusCode, dl.body).toBe(200);
    expect(dl.body).toBe('secret bytes');
    fromShard(dl);
    const second = await visit(token, 'content?inline=1', { cookie });
    expect(second.statusCode).toBe(410);
    expect(second.json()).toEqual({ code: 'DOWNLOAD_LIMIT_REACHED' });
  });

  it('file with an expiry: serves before it, 410 LINK_EXPIRED after it', async () => {
    const path = await seedFile(kind, 'until tomorrow');
    const token = await link(kind, path, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect((await visit(token, 'content')).body).toBe('until tomorrow');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 120_000);
    for (const rest of ['info', 'content']) {
      const r = await visit(token, rest);
      expect(r.statusCode, rest).toBe(410);
      expect(r.json()).toEqual({ code: 'LINK_EXPIRED' });
    }
  });
});

describe.each(['drive', 'dropbox'] as const)('edge cases on %s', (kind) => {
  it('unlinking the connection orphans its shares and links: 410, never the home', async () => {
    const provider = kind === 'drive' ? 'google-drive' : 'dropbox';
    const second = await connect(provider, 'acct-member');
    expect(second).not.toBe(conn[kind]);
    const saved = conn[kind];
    conn[kind] = second;
    try {
      const dir = await seedFolder(kind);
      await ok(put(owner, 'home', dir, 'HOME BYTES')); // the same path in the home must never be served instead
      const s = await share(kind, dir, 'edit');
      const token = await link(kind, dir);
      expect((await get(grantee, s, 'list', '/')).statusCode).toBe(200);
      expect((await visit(token, 'list')).statusCode).toBe(200);
      const del = await as(owner, 'DELETE', `/api/v1/connections/${second.slice('conn:'.length)}`);
      expect(del.statusCode, del.body).toBe(204);
      for (const r of [await get(grantee, s, 'list', '/'), await get(grantee, s, 'content', '/note.txt'),
        await put(grantee, s, '/x.txt', 'x'), await visit(token, 'info'), await visit(token, 'list'),
        await visit(token, `content?${q('/note.txt')}`)]) {
        expect(r.statusCode, r.body).toBe(410);
        expect(r.json()).toEqual({ code: 'SHARE_ORPHANED' });
      }
      expect(stored(kind, `${dir}/x.txt`)).toBeUndefined();
    } finally {
      conn[kind] = saved;
    }
  });

  it('an item renamed at the provider: the share and the link answer 404 NOT_FOUND (they name a path)', async () => {
    const dir = await seedFolder(kind);
    const s = await share(kind, dir, 'read');
    const token = await link(kind, dir);
    expect((await get(grantee, s, 'list', '/')).statusCode).toBe(200);
    if (kind === 'drive') fake.drive.byPath(dir)!.name = `${dir.slice(1)}-renamed`;
    else (fake.dropbox as unknown as { relocate(i: unknown, to: string, keep: boolean): void })
      .relocate({ ...fake.dropbox.byPath(dir)! }, `${dir}-renamed`, false); // a copy: relocate rewrites the item it moves
    // Past Drive's 30 s path cache, so the rename made elsewhere shows.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    for (const r of [await get(grantee, s, 'list', '/'), await get(grantee, s, 'content', '/note.txt'),
      await visit(token, 'info'), await visit(token, 'list')]) {
      expect(r.statusCode, r.body).toBe(404);
      expect(r.json()).toEqual({ code: 'NOT_FOUND' });
    }
    expect(stored(kind, `${dir}-renamed/note.txt`)).toBe('hello from the owner');
  });

  it('an item the owner renames through their connection in the app: the share and the link answer 404 as well', async () => {
    const dir = await seedFolder(kind);
    const s = await share(kind, dir, 'read');
    const token = await link(kind, dir);
    await ok(op(owner, conn[kind], 'move', { from: dir, to: `${dir}-moved`, onCollision: 'fail' }));
    for (const r of [await get(grantee, s, 'list', '/'), await visit(token, 'info')]) {
      expect(r.statusCode, r.body).toBe(404);
      expect(r.json()).toEqual({ code: 'NOT_FOUND' });
    }
  });
});
