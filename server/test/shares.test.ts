import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homeRoot } from '../src/paths.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// #146: internal shares. The owner (`testuser`) shares items of their home with `member`; `member2` is a third member
// who is not a grantee. Every access through `share:<id>` is checked against the share row.

type S = { cookie: string; csrf: string };
let t: TestApp; let owner: S; let grantee: S; let other: S;
let ownerId: string; let granteeId: string; let otherId: string;
const ORIGIN = 'https://files.example.com';
const mutating = (s: S) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN });
const idOf = async (s: S) => (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id as string;

beforeAll(async () => {
  t = await startTestApp({ FILES_MAX_UPLOAD_BYTES: String(1024 ** 2) });
  owner = await login(t, 'testuser'); grantee = await login(t, 'member'); other = await login(t, 'member2');
  ownerId = await idOf(owner); granteeId = await idOf(grantee); otherId = await idOf(other);
});
afterAll(() => t.close());

const src = (source: string) => `/api/v1/sources/${encodeURIComponent(source)}`;
const post = (source: string, op: string, payload: unknown, s: S) => t.app.inject({
  method: 'POST', url: `${src(source)}/${op}`, headers: mutating(s), payload: payload as object });
const put = (source: string, path: string, text: string, s: S, onCollision = 'fail') => t.app.inject({
  method: 'PUT', url: `${src(source)}/content?path=${encodeURIComponent(path)}&onCollision=${onCollision}`,
  headers: { ...mutating(s), 'content-type': 'application/octet-stream' }, payload: Buffer.from(text) });
const get = (source: string, op: string, path: string, s: S) => t.app.inject({
  url: `${src(source)}/${op}?path=${encodeURIComponent(path)}`, headers: { cookie: s.cookie } });
const expectOk = async (r: Promise<{ statusCode: number; body: string }>) => {
  const x = await r; expect(x.statusCode, x.body).toBeLessThan(300); return x;
};
const share = (payload: Record<string, unknown>, s: S = owner) =>
  t.app.inject({ method: 'POST', url: '/api/v1/shares', headers: mutating(s), payload });
let n = 0;
/** A fresh folder in the owner's home with one file in it, shared with `member` at `access`. */
async function sharedFolder(access: 'read' | 'edit') {
  const dir = `/shared-${++n}`;
  await expectOk(post('home', 'mkdir', { path: dir }, owner));
  await expectOk(put('home', `${dir}/note.txt`, 'hello from the owner', owner));
  const r = await share({ source: 'home', path: dir, grantee: granteeId, access });
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().id as string;
  return { dir, id, source: `share:${id}` };
}
const ownerFile = (p: string) => join(homeRoot(t.config.dataDir, ownerId), p);

describe('ETag for a grantee (#279)', () => {
  it('reveals neither the inode nor the mtime of the owner\'s file, and still guards an edit with If-Match', async () => {
    const s = await sharedFolder('edit');
    const dl = await get(s.source, 'content', '/note.txt', grantee);
    expect(dl.body).toBe('hello from the owner');
    const etag = String(dl.headers.etag);
    const st = lstatSync(ownerFile(`${s.dir}/note.txt`));
    expect(etag).not.toContain(st.ino.toString(16));
    expect(etag).not.toContain(Math.floor(st.mtimeMs).toString(16));
    const putIfMatch = (tag: string, text: string) => t.app.inject({ method: 'PUT',
      url: `${src(s.source)}/content?path=${encodeURIComponent('/note.txt')}&onCollision=replace`,
      headers: { ...mutating(grantee), 'content-type': 'application/octet-stream', 'if-match': tag }, payload: Buffer.from(text) });
    expect((await putIfMatch(etag, 'edited')).statusCode).toBe(201);
    expect((await putIfMatch(etag, 'lost update')).statusCode).toBe(412);
    expect(readFileSync(ownerFile(`${s.dir}/note.txt`), 'utf8')).toBe('edited');
  });
});

describe('read share', () => {
  it('the grantee can list and download; write, mkdir, rename and delete answer 403 and change nothing', async () => {
    const s = await sharedFolder('read');
    const list = await get(s.source, 'list', '/', grantee);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().access).toBe('read');
    expect(list.json().entries.map((e: { name: string; path: string }) => [e.name, e.path])).toEqual([['note.txt', '/note.txt']]);
    const dl = await get(s.source, 'content', '/note.txt', grantee);
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('hello from the owner');
    const root = await get(s.source, 'stat', '/', grantee);
    expect(root.json()).toMatchObject({ name: s.dir.slice(1), path: '/', type: 'directory' });

    expect((await put(s.source, '/new.txt', 'x', grantee)).statusCode).toBe(403);
    expect((await put(s.source, '/note.txt', 'x', grantee, 'replace')).statusCode).toBe(403);
    expect((await post(s.source, 'mkdir', { path: '/sub' }, grantee)).statusCode).toBe(403);
    expect((await post(s.source, 'move', { from: '/note.txt', to: '/renamed.txt', onCollision: 'fail' }, grantee)).statusCode).toBe(403);
    expect((await post(s.source, 'copy', { from: '/note.txt', to: '/copy.txt', onCollision: 'fail' }, grantee)).statusCode).toBe(403);
    expect((await post(s.source, 'delete', { paths: ['/note.txt'] }, grantee)).statusCode).toBe(403);
    expect(readFileSync(ownerFile(`${s.dir}/note.txt`), 'utf8')).toBe('hello from the owner');
    expect(existsSync(ownerFile(`${s.dir}/new.txt`))).toBe(false);
    expect(existsSync(ownerFile(`${s.dir}/sub`))).toBe(false);
    expect(existsSync(ownerFile(`${s.dir}/renamed.txt`))).toBe(false);
  });

  it('a path with `..` cannot leave the shared folder', async () => {
    const s = await sharedFolder('read');
    await expectOk(put('home', '/outside.txt', 'owner private', owner, 'replace'));
    for (const p of ['/../outside.txt', '/..', '../outside.txt', '/note.txt/../../outside.txt', '/%2e%2e/outside.txt']) {
      const r = await get(s.source, 'content', p, grantee);
      expect(r.statusCode, p).toBeGreaterThanOrEqual(400);
      expect(r.body, p).not.toContain('owner private');
    }
    const up = await get(s.source, 'list', '/..', grantee);
    expect(up.statusCode).toBe(400);
    // An absolute path is relative to the shared folder, never to the owner's home.
    const abs = await get(s.source, 'content', '/outside.txt', grantee);
    expect(abs.statusCode).toBe(404);
    expect(abs.body).not.toContain('owner private');
  });

  it('a file share opens the file itself at `/`', async () => {
    await expectOk(put('home', '/single.txt', 'just this one', owner, 'replace'));
    const r = await share({ source: 'home', path: '/single.txt', grantee: granteeId, access: 'read' });
    expect(r.statusCode, r.body).toBe(201);
    const source = `share:${r.json().id}`;
    const dl = await get(source, 'content', '/', grantee);
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('just this one');
    expect(String(dl.headers['content-disposition'])).toContain('single.txt');
  });
});

describe('edit share', () => {
  it('write, mkdir, rename, copy and delete succeed inside the shared folder and land in the owner\'s home', async () => {
    const s = await sharedFolder('edit');
    const list = await get(s.source, 'list', '/', grantee);
    expect(list.json().access).toBe('edit');
    expect((await put(s.source, '/from-member.txt', 'written by the grantee', grantee)).statusCode).toBe(201);
    expect(readFileSync(ownerFile(`${s.dir}/from-member.txt`), 'utf8')).toBe('written by the grantee');
    await expectOk(post(s.source, 'mkdir', { path: '/sub' }, grantee));
    await expectOk(post(s.source, 'move', { from: '/note.txt', to: '/sub/renamed.txt', onCollision: 'fail' }, grantee));
    expect(readFileSync(ownerFile(`${s.dir}/sub/renamed.txt`), 'utf8')).toBe('hello from the owner');
    await expectOk(post(s.source, 'copy', { from: '/sub/renamed.txt', to: '/copy.txt', onCollision: 'fail' }, grantee));
    expect(existsSync(ownerFile(`${s.dir}/copy.txt`))).toBe(true);
    await expectOk(post(s.source, 'delete', { paths: ['/copy.txt'] }, grantee));
    expect(existsSync(ownerFile(`${s.dir}/copy.txt`))).toBe(false);
    // Nothing of it reached the grantee's own home.
    expect(existsSync(join(homeRoot(t.config.dataDir, granteeId), 'from-member.txt'))).toBe(false);
  });

  it('nothing outside the shared folder can be written, and the shared folder itself cannot be renamed or deleted', async () => {
    const s = await sharedFolder('edit');
    expect((await put(s.source, '/../escaped.txt', 'x', grantee)).statusCode).toBe(400);
    expect((await post(s.source, 'move', { from: '/note.txt', to: '/../escaped.txt', onCollision: 'fail' }, grantee)).statusCode).toBe(400);
    expect((await post(s.source, 'copy', { from: '/note.txt', to: '/../escaped.txt', onCollision: 'fail' }, grantee)).statusCode).toBe(400);
    expect((await post(s.source, 'mkdir', { path: '/../escaped' }, grantee)).statusCode).toBe(400);
    expect(existsSync(ownerFile('/escaped.txt'))).toBe(false);
    expect(existsSync(ownerFile('/escaped'))).toBe(false);
    expect(readFileSync(ownerFile(`${s.dir}/note.txt`), 'utf8')).toBe('hello from the owner');

    for (const [op, body] of [
      ['move', { from: '/', to: '/renamed', onCollision: 'fail' }],
      ['move', { from: '/note.txt', to: '/', onCollision: 'replace' }],
      ['copy', { from: '/', to: '/inner', onCollision: 'fail' }],
      ['delete', { paths: ['/'] }],
    ] as const) {
      const r = await post(s.source, op, body, grantee);
      expect(r.statusCode, `${op} ${JSON.stringify(body)}`).toBe(403);
    }
    expect(existsSync(ownerFile(s.dir))).toBe(true);
  });

  it('a file share at edit: `/` with keep-both or fail writes nothing beside the file (#252)', async () => {
    const dir = `/private-${++n}`;
    await expectOk(post('home', 'mkdir', { path: dir }, owner));
    await expectOk(put('home', `${dir}/shared.txt`, 'the shared file', owner));
    const r = await share({ source: 'home', path: `${dir}/shared.txt`, grantee: granteeId, access: 'edit' });
    expect(r.statusCode, r.body).toBe(201);
    const source = `share:${r.json().id}`;
    const listing = async () => (await get('home', 'list', dir, owner)).json().entries.map((e: { name: string }) => e.name).sort();
    expect(await listing()).toEqual(['shared.txt']);

    for (const root of ['/', '//', '/', '///']) {
      const kb = await put(source, root, 'planted by the grantee', grantee, 'keep-both');
      expect(kb.statusCode, `${root}: ${kb.body}`).toBe(403);
      expect(kb.json().code).toBe('FORBIDDEN');
    }
    const fail = await put(source, '/', 'planted by the grantee', grantee, 'fail');
    expect(fail.statusCode, fail.body).toBe(409);
    expect(fail.json().code).toBe('FILE_EXISTS');
    expect(await listing()).toEqual(['shared.txt']);
    expect(existsSync(ownerFile(`${dir}/shared (1).txt`))).toBe(false);
    expect(readFileSync(ownerFile(`${dir}/shared.txt`), 'utf8')).toBe('the shared file');

    // Overwriting the shared file itself stays allowed.
    expect((await put(source, '/', 'changed by the grantee', grantee, 'replace')).statusCode).toBe(201);
    expect(readFileSync(ownerFile(`${dir}/shared.txt`), 'utf8')).toBe('changed by the grantee');
    expect(await listing()).toEqual(['shared.txt']);
  });

  it('a folder share at edit: every write at `/` is 403 and changes nothing (#252)', async () => {
    const s = await sharedFolder('edit');
    const rootNames = async () => (await get('home', 'list', '/', owner)).json().entries.map((e: { name: string }) => e.name).sort();
    const before = await rootNames();
    for (const [root, policy] of [['/', 'keep-both'], ['//', 'replace'], ['/', 'fail']]) {
      const w = await put(s.source, root!, 'planted by the grantee', grantee, policy);
      expect(w.statusCode, `${root} ${policy}: ${w.body}`).toBe(403);
      expect(w.json().code).toBe('FORBIDDEN');
    }
    expect(await rootNames()).toEqual(before);
    expect(readFileSync(ownerFile(`${s.dir}/note.txt`), 'utf8')).toBe('hello from the owner');
  });
});

describe('who may use a share', () => {
  it('a member who is not the grantee gets 404 SOURCE_NOT_FOUND, like for an unknown id', async () => {
    const s = await sharedFolder('edit');
    for (const [who, sess] of [['other member', other], ['owner', owner]] as const) {
      for (const r of [await get(s.source, 'list', '/', sess), await get(s.source, 'content', '/note.txt', sess),
        await put(s.source, '/x.txt', 'x', sess)]) {
        expect(r.statusCode, who).toBe(404);
        expect(r.json(), who).toEqual({ code: 'SOURCE_NOT_FOUND' });
      }
    }
    expect((await get('share:doesnotexist', 'list', '/', grantee)).json()).toEqual({ code: 'SOURCE_NOT_FOUND' });
  });

  it('revoking takes effect on the next request', async () => {
    const s = await sharedFolder('read');
    expect((await get(s.source, 'list', '/', grantee)).statusCode).toBe(200);
    const del = await t.app.inject({ method: 'DELETE', url: `/api/v1/shares/${s.id}`, headers: mutating(owner) });
    expect(del.statusCode).toBe(204);
    expect((await get(s.source, 'list', '/', grantee)).statusCode).toBe(404);
  });

  it('changing the access level is re-checked on every request', async () => {
    const s = await sharedFolder('edit');
    expect((await put(s.source, '/a.txt', 'x', grantee)).statusCode).toBe(201);
    const again = await share({ source: 'home', path: s.dir, grantee: granteeId, access: 'read' });
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(s.id); // one share per item and grantee: sharing again changes the access
    expect((await put(s.source, '/b.txt', 'x', grantee)).statusCode).toBe(403);
  });

  it('a share cannot be created on behalf of another member, nor by someone who does not own the item', async () => {
    await expectOk(post('home', 'mkdir', { path: '/behalf' }, owner));
    // The owner is always the caller; a body naming another owner is refused and stores nothing.
    for (const field of ['owner', 'ownerId', 'owner_id']) {
      const r = await share({ source: 'home', path: '/behalf', grantee: otherId, access: 'read', [field]: granteeId }, owner);
      expect(r.statusCode, field).toBe(400);
    }
    // The grantee cannot share the owner's item by naming the owner's path: `home` is always the caller's own home.
    const viaHome = await share({ source: 'home', path: '/behalf', grantee: otherId, access: 'read' }, grantee);
    expect(viaHome.statusCode).toBe(404);
    const s = await sharedFolder('edit');
    // Nor re-share what was shared with them.
    const reshare = await share({ source: s.source, path: '/', grantee: otherId, access: 'read' }, grantee);
    expect(reshare.statusCode).toBe(403);
    const incoming = await t.app.inject({ url: '/api/v1/shares/incoming', headers: { cookie: other.cookie } });
    expect(incoming.json().items).toEqual([]);
    const rows = t.db.prepare('SELECT owner_id FROM shares WHERE grantee_id = ?').pluck().all(otherId);
    expect(rows).toEqual([]);
  });

  it('refuses sharing with oneself, with an unknown member and the home root', async () => {
    await expectOk(post('home', 'mkdir', { path: '/selfshare' }, owner));
    expect((await share({ source: 'home', path: '/selfshare', grantee: ownerId, access: 'read' })).statusCode).toBe(400);
    expect((await share({ source: 'home', path: '/selfshare', grantee: 'nobody', access: 'read' })).statusCode).toBe(404);
    expect((await share({ source: 'home', path: '/', grantee: granteeId, access: 'read' })).statusCode).toBe(400);
    expect((await share({ source: 'home', path: '/missing', grantee: granteeId, access: 'read' })).statusCode).toBe(404);
  });

  it('only the owner sees who has access, and only the owner or the grantee can remove a share', async () => {
    const s = await sharedFolder('read');
    const q = `/api/v1/shares?source=home&path=${encodeURIComponent(s.dir)}`;
    const mine = await t.app.inject({ url: q, headers: { cookie: owner.cookie } });
    expect(mine.json().items).toEqual([expect.objectContaining({ id: s.id, access: 'read',
      grantee: { id: granteeId, displayName: 'Test Member' } })]);
    // Another member asking about the same path asks about their own home, where nothing is shared.
    expect((await t.app.inject({ url: q, headers: { cookie: other.cookie } })).json().items).toEqual([]);
    const byOther = await t.app.inject({ method: 'DELETE', url: `/api/v1/shares/${s.id}`, headers: mutating(other) });
    expect(byOther.statusCode).toBe(404);
    expect((await get(s.source, 'list', '/', grantee)).statusCode).toBe(200);
    const byGrantee = await t.app.inject({ method: 'DELETE', url: `/api/v1/shares/${s.id}`, headers: mutating(grantee) });
    expect(byGrantee.statusCode).toBe(204);
    expect((await get(s.source, 'list', '/', grantee)).statusCode).toBe(404);
  });

  it('lists the other members of the shard for the picker, without the caller', async () => {
    const r = await t.app.inject({ url: '/api/v1/members', headers: { cookie: owner.cookie } });
    expect(r.statusCode).toBe(200);
    const names = r.json().items.map((m: { displayName: string }) => m.displayName);
    expect(names).toEqual(expect.arrayContaining(['Test Member', 'Second Member']));
    expect(names).not.toContain('Test User');
  });
});

describe('Shared with me', () => {
  it('lists the shares granted to the caller with name, type, owner and access, and nothing of other members', async () => {
    const s = await sharedFolder('edit');
    const r = await t.app.inject({ url: '/api/v1/shares/incoming', headers: { cookie: grantee.cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().items).toEqual(expect.arrayContaining([{ id: s.id, source: s.source, name: s.dir.slice(1), type: 'directory',
      access: 'edit', owner: { id: ownerId, displayName: 'Test User' }, createdAt: expect.any(String), orphaned: false }]));
    const mine = await t.app.inject({ url: '/api/v1/shares/incoming', headers: { cookie: owner.cookie } });
    expect(mine.json().items).toEqual([]);
  });
});

describe('shares follow the item', () => {
  it('after the owner moves (renames) the shared folder the share still resolves', async () => {
    const s = await sharedFolder('read');
    await expectOk(post('home', 'mkdir', { path: `/moved-${n}` }, owner));
    await expectOk(post('home', 'move', { from: s.dir, to: `/moved-${n}/renamed`, onCollision: 'fail' }, owner));
    const list = await get(s.source, 'list', '/', grantee);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().entries.map((e: { name: string }) => e.name)).toEqual(['note.txt']);
    expect((await get(s.source, 'stat', '/', grantee)).json().name).toBe('renamed');
    // Moving the folder that holds it moves the share too.
    await expectOk(post('home', 'move', { from: `/moved-${n}`, to: `/moved-again-${n}`, onCollision: 'fail' }, owner));
    expect((await get(s.source, 'content', '/note.txt', grantee)).body).toBe('hello from the owner');
  });

  it('after the owner deletes the shared folder the share answers 410 SHARE_ORPHANED, also once a new item takes its name', async () => {
    const s = await sharedFolder('edit');
    await expectOk(post('home', 'delete', { paths: [s.dir] }, owner));
    for (const r of [await get(s.source, 'list', '/', grantee), await put(s.source, '/x.txt', 'x', grantee)]) {
      expect(r.statusCode).toBe(410);
      expect(r.json()).toEqual({ code: 'SHARE_ORPHANED' });
    }
    // A new folder of the same name is a different item: it is not shared, the share never falls back to it (#95).
    await expectOk(post('home', 'mkdir', { path: s.dir }, owner));
    expect((await get(s.source, 'list', '/', grantee)).statusCode).toBe(410);
    const incoming = await t.app.inject({ url: '/api/v1/shares/incoming', headers: { cookie: grantee.cookie } });
    expect(incoming.json().items.find((i: { id: string }) => i.id === s.id)).toMatchObject({ orphaned: true });
  });

  it('a share beneath a deleted folder is orphaned, and replacing the shared item orphans its share', async () => {
    await expectOk(post('home', 'mkdir', { path: `/outer-${++n}` }, owner));
    await expectOk(put('home', `/outer-${n}/inner.txt`, 'inner', owner));
    const inner = (await share({ source: 'home', path: `/outer-${n}/inner.txt`, grantee: granteeId, access: 'read' })).json().id;
    await expectOk(post('home', 'delete', { paths: [`/outer-${n}`] }, owner));
    expect((await get(`share:${inner}`, 'content', '/', grantee)).statusCode).toBe(410);

    await expectOk(put('home', `/target-${n}.txt`, 'target', owner));
    await expectOk(put('home', `/other-${n}.txt`, 'other', owner));
    const target = (await share({ source: 'home', path: `/target-${n}.txt`, grantee: granteeId, access: 'read' })).json().id;
    await expectOk(post('home', 'move', { from: `/other-${n}.txt`, to: `/target-${n}.txt`, onCollision: 'replace' }, owner));
    expect((await get(`share:${target}`, 'content', '/', grantee)).statusCode).toBe(410);
  });

  it('a grantee\'s rename inside an edit share moves the owner\'s shares beneath it', async () => {
    const s = await sharedFolder('edit');
    await expectOk(post('home', 'mkdir', { path: `${s.dir}/deep` }, owner));
    await expectOk(put('home', `${s.dir}/deep/d.txt`, 'deep', owner));
    const deep = (await share({ source: 'home', path: `${s.dir}/deep/d.txt`, grantee: otherId, access: 'read' })).json().id;
    await expectOk(post(s.source, 'move', { from: '/deep', to: '/deeper', onCollision: 'fail' }, grantee));
    expect((await get(`share:${deep}`, 'content', '/', other)).body).toBe('deep');
  });
});
