import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeRoot } from '../src/paths.ts';
import type { ConnectedBackend } from '../src/storage/backend.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { MemBackend } from './support/memBackend.ts';

// #215: batch rename. The preview is the plan the job runs (same function, same folder listing), conflicts block the
// batch until the member picks a policy per item, and the job reports per item: a cloud item that fails mid-way is
// exactly the one listed as failed, the others are renamed.

type S = { cookie: string; csrf: string; id: string };
type Row = { path: string; name: string; to: string; action: string; conflict: string | null; problem: string | null; policy: string | null };
type Plan = { rows: Row[]; blocked: boolean };
type Job = { id: string; kind: string; status: string; total: number; done: number; failed: { path: string; code: string }[] };
const ORIGIN = 'https://files.example.com';

const as = (t: TestApp, s: S, method: string, url: string, payload?: unknown) => t.app.inject({
  method: method as 'GET', url,
  headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': s.csrf }) },
  ...(payload !== undefined ? { payload: payload as object } : {}),
});
async function signIn(t: TestApp, user: string): Promise<S> {
  const s = await login(t, user);
  return { ...s, id: (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id as string };
}
async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settled = (t: TestApp, s: S, id: string) =>
  until(async () => (await as(t, s, 'GET', `/api/v1/transfers/${id}`)).json() as Job, (j) => j.status !== 'running', `job ${id}`);
let n = 0;

describe('batch rename', () => {
  let t: TestApp; let a: S; let b: S;
  const mems: ConnectedBackend[] = [];
  const owned = new Map<string, ConnectedBackend[]>();
  const home = () => homeRoot(t.config.dataDir, a.id);
  // A fresh home folder holding `names` (each file's content is its own name).
  const folder = (names: string[]) => {
    const dir = `/batch-${++n}`;
    mkdirSync(join(home(), dir), { recursive: true });
    for (const name of names) writeFileSync(join(home(), dir, name), name);
    return dir;
  };
  const names = (dir: string) => readdirSync(join(home(), dir)).sort();
  const req = (dir: string, items: string[], ops: object, policies: Record<string, string> = {}, source = 'home') =>
    ({ source, dir, ops, items: items.map((name) => ({ path: `${dir === '/' ? '' : dir}/${name}`, ...(policies[name] ? { policy: policies[name] } : {}) })) });
  const preview = async (body: object) => {
    const r = await as(t, a, 'POST', '/api/v1/renames/preview', body);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as Plan;
  };
  const run = async (body: object) => {
    const r = await as(t, a, 'POST', '/api/v1/renames', body);
    expect(r.statusCode, r.body).toBe(201);
    return settled(t, a, (r.json() as Job).id);
  };

  beforeAll(async () => {
    t = await startTestApp({}, undefined, undefined, { connections: async (u) => owned.get(u.id) ?? [] });
    a = await signIn(t, 'testuser');
    b = await signIn(t, 'member');
    owned.set(a.id, mems);
  });
  afterAll(async () => { await t.close(); });

  it('numbers the selection in the order given, keeps the extensions, and the job does exactly what the preview showed', async () => {
    const files = ['IMG_0042.jpg', 'IMG_0007.JPG', 'beach.jpeg', 'notes.txt', 'IMG_0100.jpg'];
    const dir = folder([...files, 'other.txt']);
    const body = req(dir, files, { numbering: { pattern: 'Holiday {n:03}', start: 1 } });
    const plan = await preview(body);
    expect(plan.blocked).toBe(false);
    expect(plan.rows.map((r) => [r.name, r.to, r.action])).toEqual([
      ['IMG_0042.jpg', 'Holiday 001.jpg', 'rename'], ['IMG_0007.JPG', 'Holiday 002.JPG', 'rename'],
      ['beach.jpeg', 'Holiday 003.jpeg', 'rename'], ['notes.txt', 'Holiday 004.txt', 'rename'], ['IMG_0100.jpg', 'Holiday 005.jpg', 'rename'],
    ]);
    // Nothing changed by the preview.
    expect(names(dir)).toEqual([...files, 'other.txt'].sort());

    const job = await run(body);
    expect(job).toMatchObject({ kind: 'rename', status: 'completed', total: 5, done: 5, failed: [] });
    expect(names(dir)).toEqual([...plan.rows.map((r) => r.to), 'other.txt'].sort());
    // Each file kept its own bytes under its new name.
    for (const r of plan.rows) expect(readFileSync(join(home(), dir, r.to), 'utf8')).toBe(r.name);
  });

  it('finds and replaces plain text (no pattern syntax), changes case and adds prefix and suffix on the name without the extension', async () => {
    const dir = folder(['a.b (1).txt', 'axb (1).txt', 'Report final.PDF']);
    const plan = await preview(req(dir, ['a.b (1).txt', 'axb (1).txt'], { find: '.b (1)', replace: '-x' }));
    // A regular expression would have matched "axb (1)" too and treated the brackets as a group.
    expect(plan.rows.map((r) => r.to)).toEqual(['a-x.txt', 'axb (1).txt']);
    expect(plan.rows[1]!.action).toBe('unchanged');

    const cased = await preview(req(dir, ['Report final.PDF'], { case: 'upper', prefix: '2026 ', suffix: ' v2' }));
    expect(cased.rows[0]!.to).toBe('2026 REPORT FINAL v2.PDF');
    const title = await preview(req(dir, ['Report final.PDF'], { case: 'title' }));
    expect(title.rows[0]!.to).toBe('Report Final.PDF');
    // Opting in to the extension: the operations see the whole name.
    const whole = await preview(req(dir, ['Report final.PDF'], { case: 'lower', extension: true }));
    expect(whole.rows[0]!.to).toBe('report final.pdf');
    const job = await run(req(dir, ['Report final.PDF'], { case: 'lower', extension: true }));
    expect(job.status).toBe('completed');
    expect(names(dir)).toContain('report final.pdf');
  });

  it('flags invalid names and refuses to run while they are flagged; skipping them lets the rest run', async () => {
    const dir = folder(['one.txt', 'two.txt', 'three.txt', 'four.txt', 'five.txt']);
    const bad = await preview(req(dir, ['one.txt'], { find: 'one', replace: 'a/b' }));
    expect(bad.rows[0]).toMatchObject({ conflict: 'invalid', problem: 'slash' });
    const empty = await preview(req(dir, ['one.txt'], { find: 'one.txt', replace: '', extension: true }));
    expect(empty.rows[0]).toMatchObject({ conflict: 'invalid', problem: 'empty' });
    const long = await preview(req(dir, ['one.txt'], { suffix: 'ü'.repeat(126) }));
    expect(long.rows[0]).toMatchObject({ conflict: 'invalid', problem: 'long' });
    const reserved = await preview(req(dir, ['one.txt', 'two.txt'], { suffix: '.', extension: true }));
    expect(reserved.rows.map((r) => r.problem)).toEqual(['reserved', 'reserved']);
    expect(reserved.blocked).toBe(true);

    const blocked = await as(t, a, 'POST', '/api/v1/renames', req(dir, ['one.txt'], { find: 'one', replace: 'a/b' }));
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('RENAME_CONFLICT');
    // A policy an invalid name does not allow does not resolve it.
    expect((await as(t, a, 'POST', '/api/v1/renames', req(dir, ['one.txt'], { find: 'one', replace: 'a/b' }, { 'one.txt': 'keep-both' }))).statusCode).toBe(409);
    expect(names(dir)).toContain('one.txt');

    // "two.txt" would become "new " (a trailing space): skipped, so only "four.txt" is renamed.
    const ops = { find: 'two.txt', replace: '', extension: true, prefix: 'new ' };
    expect((await preview(req(dir, ['two.txt', 'four.txt'], ops))).rows.map((r) => [r.to, r.problem]))
      .toEqual([['new ', 'reserved'], ['new four.txt', null]]);
    const mixed = await run(req(dir, ['two.txt', 'four.txt'], ops, { 'two.txt': 'skip' }));
    expect(mixed).toMatchObject({ status: 'completed', total: 1, done: 1 });
    expect(names(dir)).toEqual(['five.txt', 'new four.txt', 'one.txt', 'three.txt', 'two.txt']);
  });

  it('refuses a collision with an existing item until a policy is picked, and the preview shows the name each policy gives', async () => {
    const dir = folder(['a.txt', 'b.txt', 'taken.txt']);
    const plan = await preview(req(dir, ['a.txt'], { find: 'a', replace: 'taken' }));
    expect(plan.rows[0]).toMatchObject({ to: 'taken.txt', conflict: 'exists', policy: null });
    expect(plan.blocked).toBe(true);
    const refused = await as(t, a, 'POST', '/api/v1/renames', req(dir, ['a.txt'], { find: 'a', replace: 'taken' }));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('RENAME_CONFLICT');
    expect(names(dir)).toEqual(['a.txt', 'b.txt', 'taken.txt']);

    // Ignoring case, as Dropbox and OneDrive do: "TAKEN.txt" collides too.
    expect((await preview(req(dir, ['a.txt'], { find: 'a', replace: 'TAKEN' }))).rows[0]!.conflict).toBe('exists');

    const both = req(dir, ['a.txt'], { find: 'a', replace: 'taken' }, { 'a.txt': 'keep-both' });
    const shown = await preview(both);
    expect(shown.rows[0]).toMatchObject({ to: 'taken (1).txt', conflict: 'exists', policy: 'keep-both' });
    expect(shown.blocked).toBe(false);
    await run(both);
    expect(names(dir)).toEqual(['b.txt', 'taken (1).txt', 'taken.txt']);

    // Replace sends the other item to the trash, never deletes it.
    const job = await run(req(dir, ['b.txt'], { find: 'b', replace: 'taken' }, { 'b.txt': 'replace' }));
    expect(job.status).toBe('completed');
    expect(names(dir)).toEqual(['taken (1).txt', 'taken.txt']);
    expect(readFileSync(join(home(), dir, 'taken.txt'), 'utf8')).toBe('b.txt');
    const trash = (await as(t, a, 'GET', '/api/v1/trash')).json() as { items: { originalPath: string }[] };
    expect(trash.items.map((i) => i.originalPath)).toContain(`${dir}/taken.txt`);
  });

  it('flags two items that would get the same name, and a name another selected item holds; neither may replace', async () => {
    const dir = folder(['x1.txt', 'x2.txt', 'y.txt']);
    const plan = await preview(req(dir, ['x1.txt', 'x2.txt'], { numbering: { pattern: 'same', start: 1 } }));
    expect(plan.rows.map((r) => r.conflict)).toEqual([null, 'batch']);
    const swap = await preview(req(dir, ['x1.txt', 'y.txt'], { find: 'x1', replace: 'y' }));
    expect(swap.rows[0]).toMatchObject({ to: 'y.txt', conflict: 'batch' });
    // A selected item is never replaced by another one of the batch.
    expect((await as(t, a, 'POST', '/api/v1/renames',
      req(dir, ['x1.txt', 'x2.txt'], { numbering: { pattern: 'same', start: 1 } }, { 'x2.txt': 'replace' }))).statusCode).toBe(409);
    const both = req(dir, ['x1.txt', 'x2.txt'], { numbering: { pattern: 'same', start: 1 } }, { 'x2.txt': 'keep-both' });
    expect((await preview(both)).rows.map((r) => r.to)).toEqual(['same.txt', 'same (1).txt']);
    await run(both);
    expect(names(dir)).toEqual(['same (1).txt', 'same.txt', 'y.txt']);
  });

  it('renames a 500-item batch', async () => {
    const files = Array.from({ length: 500 }, (_, i) => `scan ${String(i).padStart(3, '0')}.png`);
    const dir = folder(files);
    const body = req(dir, files, { find: 'scan', replace: 'page' });
    const plan = await preview(body);
    expect(plan.rows).toHaveLength(500);
    const job = await run(body);
    expect(job).toMatchObject({ status: 'completed', total: 500, done: 500, failed: [] });
    expect(names(dir)).toEqual(files.map((f) => f.replace('scan', 'page')).sort());
  }, 120_000);

  it('reports exactly the cloud item that fails mid-way; the others are renamed', async () => {
    const m = new MemBackend();
    mems.push({ id: 'cloud', backend: m });
    for (const f of ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']) m.put(`/Trip/${f}`, f);
    m.failMove.add('/Trip/c.jpg');
    const body = req('/Trip', ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'], { numbering: { pattern: 'Trip {n}', start: 1 } }, {}, 'conn:cloud');
    const job = await run(body);
    expect(job).toMatchObject({ status: 'completed_with_errors', total: 5, done: 4 });
    expect(job.failed).toEqual([{ path: '/Trip/c.jpg', code: 'PROVIDER_UNAVAILABLE' }]);
    expect([...m.files.keys()].sort()).toEqual(['/Trip/Trip 1.jpg', '/Trip/Trip 2.jpg', '/Trip/Trip 4.jpg', '/Trip/Trip 5.jpg', '/Trip/c.jpg']);
    // The CSV report lists what was renamed and what was not.
    const csv = (await as(t, a, 'GET', `/api/v1/transfers/${job.id}/report`)).body;
    expect(csv).toContain('"failed","/Trip/c.jpg"');
    expect(csv).toContain('"done","/Trip/a.jpg","/Trip/Trip 1.jpg"');
  });

  it('carries a cloud item\'s favourite along with its new name', async () => {
    const m = new MemBackend();
    mems.push({ id: 'fav', backend: m });
    m.put('/doc.txt', 'x');
    expect((await as(t, a, 'POST', '/api/v1/favourites', { source: 'conn:fav', path: '/doc.txt' })).statusCode).toBeLessThan(300);
    await run(req('/', ['doc.txt'], { prefix: 'old ' }, {}, 'conn:fav'));
    const favs = (await as(t, a, 'GET', '/api/v1/favourites')).json() as { items: { source: string; path: string }[] };
    expect(favs.items.filter((f) => f.source === 'conn:fav').map((f) => f.path)).toEqual(['/old doc.txt']);
  });

  it('needs edit access and items of the one folder', async () => {
    const dir = folder(['p.txt', 'q.txt']);
    // Another member cannot address the caller's home at all.
    const other = await as(t, b, 'POST', '/api/v1/renames/preview', req(dir, ['p.txt'], { prefix: 'x' }));
    expect(other.statusCode).toBe(404);
    expect(existsSync(join(home(), dir, 'p.txt'))).toBe(true);
    // A read share offers no rename.
    const share = await as(t, a, 'POST', '/api/v1/shares', { source: 'home', path: dir, grantee: b.id, access: 'read' });
    expect(share.statusCode, share.body).toBe(201);
    const sid = `share:${(share.json() as { id: string }).id}`;
    const ro = await as(t, b, 'POST', '/api/v1/renames', req('/', ['p.txt'], { prefix: 'x' }, {}, sid));
    expect(ro.statusCode).toBe(403);
    // Items outside the named folder are refused.
    const outside = await as(t, a, 'POST', '/api/v1/renames/preview', { source: 'home', dir, ops: { prefix: 'x' }, items: [{ path: '/elsewhere.txt' }] });
    expect(outside.statusCode).toBe(400);
    expect(names(dir)).toEqual(['p.txt', 'q.txt']);
  });
});
