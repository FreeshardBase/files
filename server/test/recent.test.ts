import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { homeRoot } from '../src/paths.ts';
import { RECENT_CAP } from '../src/storage/recent.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// #141: the Recent view. Every write path in the home records the item for its member; moves rewrite and deletes
// remove the entries in the same transaction (the #137 cascade through PATH_TABLES).

type S = { cookie: string; csrf: string };
let t: TestApp; let a: S; let m: S;
const ORIGIN = 'https://files.example.com';
beforeAll(async () => {
  t = await startTestApp({ FILES_MAX_UPLOAD_BYTES: String(1024 ** 2) });
  a = await login(t, 'testuser');
  m = await login(t, 'member');
  for (const s of [a, m]) {
    const id = (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id;
    mkdirSync(homeRoot(t.config.dataDir, id), { recursive: true });
  }
});
afterAll(() => t.close());

const mutating = (s: S) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN });
const post = (op: string, payload: unknown, s: S = a) => t.app.inject({
  method: 'POST', url: `/api/v1/sources/home/${op}`, headers: mutating(s), payload: payload as object });
const put = async (path: string, text: string, s: S = a) => {
  const r = await t.app.inject({ method: 'PUT', url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=fail`,
    headers: { ...mutating(s), 'content-type': 'application/octet-stream' }, payload: Buffer.from(text) });
  expect(r.statusCode, r.body).toBe(201);
};
const b64 = (v: string) => Buffer.from(v).toString('base64');
// A resumable upload (the SPA's way), in one PATCH.
const tus = async (path: string, text: string, s: S = a) => {
  const h = { ...mutating(s), 'tus-resumable': '1.0.0' };
  const c = await t.app.inject({ method: 'POST', url: '/api/v1/uploads',
    headers: { ...h, 'upload-length': String(text.length), 'upload-metadata': `source ${b64('home')},path ${b64(path)}` } });
  expect(c.statusCode, c.body).toBe(201);
  const p = await t.app.inject({ method: 'PATCH', url: String(c.headers.location),
    headers: { ...h, 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' }, payload: Buffer.from(text) });
  expect(p.statusCode, p.body).toBe(204);
};
const mkdir = async (path: string, s: S = a) => expect((await post('mkdir', { path }, s)).statusCode).toBe(201);
const ok = async (r: Promise<{ statusCode: number; body: string }>) => { const x = await r; expect(x.statusCode, x.body).toBeLessThan(300); };
const move = (from: string, to: string, s: S = a) => ok(post('move', { from, to, onCollision: 'fail' }, s));
const recent = async (s: S = a) => {
  const r = await t.app.inject({ url: '/api/v1/recent', headers: { cookie: s.cookie } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { items: { source: string; name: string; path: string; type: string; changedAt: string }[] };
};
const paths = async (s: S = a) => (await recent(s)).items.map((i) => i.path);
let n = 0;
const fresh = async (stem: string, s: S = a) => { const d = `/${stem}-${++n}`; await mkdir(d, s); return d; };

describe('Recent', () => {
  it('needs a session', async () => {
    expect((await t.app.inject({ url: '/api/v1/recent' })).statusCode).toBe(401);
  });

  it('after upload, rename and move it lists the current paths, newest first, and only the caller\'s own files', async () => {
    const d = await fresh('flow');
    await mkdir(`${d}/sub`);
    await put(`${d}/a.txt`, 'a');
    await tus(`${d}/b.txt`, 'b');
    await put(`${d}/c.txt`, 'c');
    const mine = (await paths()).filter((p) => p.startsWith(d));
    expect(mine).toEqual([`${d}/c.txt`, `${d}/b.txt`, `${d}/a.txt`]);

    await move(`${d}/a.txt`, `${d}/renamed.txt`); // rename
    await move(`${d}/c.txt`, `${d}/sub/c.txt`); // move
    const after = (await paths()).filter((p) => p.startsWith(d));
    expect(after).toEqual([`${d}/sub/c.txt`, `${d}/renamed.txt`, `${d}/b.txt`]);
    const item = (await recent()).items.find((i) => i.path === `${d}/renamed.txt`)!;
    expect(item).toMatchObject({ source: 'home', name: 'renamed.txt', type: 'file' });
    expect(Number.isNaN(Date.parse(item.changedAt))).toBe(false);

    // Another member's writes, even to the same paths in their own home, never appear.
    const md = await fresh('member-flow', m);
    await put(`${md}/secret.txt`, 'x', m);
    await put(`${d}/a.txt`, 'x', m); // the caller renamed theirs away; the member's own file of that name is not theirs
    const ps = await paths();
    expect(ps.some((p) => p.startsWith(md))).toBe(false);
    expect(ps).not.toContain(`${d}/a.txt`);
    expect(await paths(m)).toEqual(expect.arrayContaining([`${md}/secret.txt`, `${d}/a.txt`]));
    expect(await paths(m)).not.toContain(`${d}/renamed.txt`);
  });

  it('a folder move rewrites the entries beneath it', async () => {
    const d = await fresh('foldermove');
    await mkdir(`${d}/x`);
    await put(`${d}/x/inner.txt`, 'i');
    await move(`${d}/x`, `${d}/y`);
    const ps = await paths();
    expect(ps).toContain(`${d}/y/inner.txt`);
    expect(ps).not.toContain(`${d}/x/inner.txt`);
    expect(ps[0]).toBe(`${d}/y`); // the moved folder itself is the newest change
  });

  it('a deleted file disappears, and so do the entries beneath a deleted folder', async () => {
    const d = await fresh('delete');
    await put(`${d}/gone.txt`, 'g');
    await mkdir(`${d}/f`);
    await put(`${d}/f/deep.txt`, 'd');
    await put(`${d}/stays.txt`, 's');
    await ok(post('delete', { paths: [`${d}/gone.txt`] }));
    expect(await paths()).not.toContain(`${d}/gone.txt`);
    await ok(post('delete', { paths: [`${d}/f`] }));
    const ps = await paths();
    expect(ps).not.toContain(`${d}/f/deep.txt`);
    expect(ps).toContain(`${d}/stays.txt`);
  });

  it('copy and restore record the item at its new place', async () => {
    const d = await fresh('copyrestore');
    await put(`${d}/orig.txt`, 'o');
    await put(`${d}/back.txt`, 'b');
    await ok(post('copy', { from: `${d}/orig.txt`, to: `${d}/copy.txt`, onCollision: 'fail' }));
    expect((await paths())[0]).toBe(`${d}/copy.txt`);

    await ok(post('delete', { paths: [`${d}/back.txt`] }));
    expect(await paths()).not.toContain(`${d}/back.txt`);
    const trash = (await t.app.inject({ url: '/api/v1/trash', headers: { cookie: a.cookie } })).json();
    const id = trash.items.find((i: { originalPath: string }) => i.originalPath === `${d}/back.txt`).id;
    await ok(t.app.inject({ method: 'POST', url: '/api/v1/trash/restore', headers: mutating(a), payload: { id, onCollision: 'fail' } }));
    expect((await paths())[0]).toBe(`${d}/back.txt`);
  });

  it('writing an item again moves it to the top instead of listing it twice', async () => {
    const d = await fresh('again');
    await put(`${d}/one.txt`, '1');
    await put(`${d}/two.txt`, '2');
    await t.app.inject({ method: 'PUT', url: `/api/v1/sources/home/content?path=${encodeURIComponent(`${d}/one.txt`)}&onCollision=replace`,
      headers: { ...mutating(a), 'content-type': 'application/octet-stream' }, payload: Buffer.from('1b') });
    const mine = (await paths()).filter((p) => p.startsWith(d));
    expect(mine).toEqual([`${d}/one.txt`, `${d}/two.txt`]);
  });

  it(`keeps at most ${RECENT_CAP} entries per member, dropping the oldest`, async () => {
    const d = await fresh('cap');
    const md = await fresh('cap-member', m);
    await put(`${md}/kept.txt`, 'k', m);
    for (let i = 0; i < RECENT_CAP + 5; i++) await put(`${d}/f${i}.txt`, 'x');
    const ps = await paths();
    expect(ps).toHaveLength(RECENT_CAP);
    expect(ps[0]).toBe(`${d}/f${RECENT_CAP + 4}.txt`);
    expect(ps).not.toContain(`${d}/f4.txt`);
    expect(ps).toContain(`${d}/f5.txt`);
    // The member's list is untouched by the caller's cap.
    expect(await paths(m)).toContain(`${md}/kept.txt`);
  });
});
