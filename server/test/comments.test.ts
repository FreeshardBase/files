import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Comment, CommentList, FolderComments } from '@files/shared';
import { homeRoot } from '../src/paths.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { startFakeProvider, type FakeProvider } from './support/fakeProvider.ts';

// #213: comments on files and folders. One thread per item, keyed by the item's owner, the owner's source and the
// owner's path, so the owner and every grantee see the same thread; a member who cannot reach the item gets the 404 of
// an unknown item. Home rows follow moves (PATH_TABLES), wait in the trash with their item and go with its purge
// (TRASH_TABLES); cloud rows follow the moves and deletes made through the app, also through a share.

type S = { cookie: string; csrf: string; id: string };
const ORIGIN = 'https://files.example.com';
let t: TestApp; let fake: FakeProvider; let a: S; let m: S; let o: S;

beforeAll(async () => {
  fake = await startFakeProvider();
  for (const f of ['/Docs/a.txt', '/Docs/b.txt', '/Docs/c.txt', '/top.txt']) fake.put(f, `bytes of ${f}`);
  t = await startTestApp({}, undefined, undefined, { providers: [fake.provider()] });
  for (const [user, set] of [['testuser', (s: S) => { a = s; }], ['member', (s: S) => { m = s; }], ['member2', (s: S) => { o = s; }]] as const) {
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
const put = async (s: S, path: string, text = 'x') => {
  const r = await t.app.inject({ method: 'PUT', url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=fail`,
    headers: { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf, 'content-type': 'application/octet-stream' }, payload: Buffer.from(text) });
  expect(r.statusCode, r.body).toBe(201);
};
const mkdir = (s: S, path: string, source = 'home') => ok(op(s, source, 'mkdir', { path }));
const move = (s: S, from: string, to: string, source = 'home') => ok(op(s, source, 'move', { from, to, onCollision: 'fail' }));
const del = (s: S, paths: string[], source = 'home') => ok(op(s, source, 'delete', { paths }));
const q = (source: string, path: string) => `source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`;
const post = (s: S, source: string, path: string, text: string) => as(s, 'POST', '/api/v1/comments', { source, path, text });
const say = async (s: S, source: string, path: string, text: string): Promise<Comment> => {
  const r = await post(s, source, path, text);
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as Comment;
};
const edit = (s: S, id: number, source: string, path: string, text: string) => as(s, 'PATCH', `/api/v1/comments/${id}`, { source, path, text });
const remove = (s: S, id: number, source: string, path: string) => as(s, 'DELETE', `/api/v1/comments/${id}?${q(source, path)}`);
const read = (s: S, source: string, path: string) => as(s, 'GET', `/api/v1/comments?${q(source, path)}`);
const thread = async (s: S, source: string, path: string): Promise<Comment[]> => {
  const r = await read(s, source, path);
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as CommentList).comments;
};
const texts = async (s: S, source: string, path: string) => (await thread(s, source, path)).map((c) => c.text);
const counts = async (s: S, source: string, dir: string) => {
  const r = await as(s, 'GET', `/api/v1/comments/folder?${q(source, dir)}`);
  expect(r.statusCode, r.body).toBe(200);
  return Object.fromEntries((r.json() as FolderComments).items.map((i) => [i.path, i.count]));
};
const rows = (path: string) => t.db.prepare('SELECT count(*) FROM comments WHERE path = ?').pluck().get(path) as number;
const share = async (owner: S, source: string, path: string, grantee: S, access: 'read' | 'edit') =>
  (await ok(as(owner, 'POST', '/api/v1/shares', { source, path, grantee: grantee.id, access }))).json().id as string;
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

describe('comments', () => {
  it('are kept as plain text, oldest first, with author and times', async () => {
    const d = await fresh(a, 'plain');
    await put(a, `${d}/f.txt`);
    const first = await say(a, 'home', `${d}/f.txt`, '  <b>bold</b> https://example.com\r\nsecond line\t ');
    expect(first).toMatchObject({ text: '<b>bold</b> https://example.com\nsecond line', author: { id: a.id, displayName: 'Test User' },
      edited: null, mine: true, canDelete: true });
    expect(Date.parse(first.created)).not.toBeNaN();
    await say(a, 'home', `${d}/f.txt`, 'later');
    expect(await texts(a, 'home', `${d}/f.txt`)).toEqual([first.text, 'later']);
    // A folder has a thread of its own.
    await say(a, 'home', d, 'on the folder');
    expect(await texts(a, 'home', d)).toEqual(['on the folder']);
  });

  it('refuse empty text, more than 4000 characters, control characters, the root and a missing item', async () => {
    const d = await fresh(a, 'limits');
    await put(a, `${d}/f.txt`);
    await say(a, 'home', `${d}/f.txt`, 'ä'.repeat(4000));
    for (const bad of ['ä'.repeat(4001), ' \n ', 'a\u0000b', 'a‮b']) {
      const r = await post(a, 'home', `${d}/f.txt`, bad);
      expect(r.statusCode, bad).toBe(400);
      expect(r.json()).toMatchObject({ code: 'COMMENT_INVALID', params: { max: 4000 } });
    }
    expect(await thread(a, 'home', `${d}/f.txt`)).toHaveLength(1);
    expect((await post(a, 'home', '/', 'x')).json().code).toBe('PATH_INVALID');
    const missing = await post(a, 'home', `${d}/nothing.txt`, 'x');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('NOT_FOUND');
  });

  it('a member without access can neither read nor write them: 404 as for an unknown item', async () => {
    const d = await fresh(a, 'private');
    await put(a, `${d}/f.txt`);
    const c = await say(a, 'home', `${d}/f.txt`, 'only mine');
    // The same path in the member's own home is the member's item, not the owner's.
    await mkdir(m, d);
    await put(m, `${d}/f.txt`);
    expect(await thread(m, 'home', `${d}/f.txt`)).toEqual([]);
    expect(await counts(m, 'home', d)).toEqual({});
    // A share granted to someone else is an unknown source.
    const other = await share(a, 'home', d, o, 'edit');
    const unknown = await read(m, 'share:0123456789abcdef0123456789abcdef', '/f.txt');
    for (const r of [await read(m, `share:${other}`, '/f.txt'), await post(m, `share:${other}`, '/f.txt', 'x'),
      await edit(m, c.id, `share:${other}`, '/f.txt', 'x'), await remove(m, c.id, `share:${other}`, '/f.txt'),
      await as(m, 'GET', `/api/v1/comments/folder?${q(`share:${other}`, '/')}`)]) {
      expect(r.statusCode, r.body).toBe(404);
      expect(r.json().code).toBe(unknown.json().code);
    }
    // Naming the owner's comment through the member's own item finds nothing either.
    for (const r of [await edit(m, c.id, 'home', `${d}/f.txt`, 'x'), await remove(m, c.id, 'home', `${d}/f.txt`)]) {
      expect(r.statusCode, r.body).toBe(404);
      expect(r.json().code).toBe('NOT_FOUND');
    }
    expect(await texts(a, 'home', `${d}/f.txt`)).toEqual(['only mine']);
    expect(await texts(m, 'home', `${d}/f.txt`)).toEqual([]);
  });

  it('on a shared item are one thread for the owner and every grantee, also with read access', async () => {
    const d = await fresh(a, 'shared');
    await put(a, `${d}/plan.txt`);
    await say(a, 'home', `${d}/plan.txt`, 'owner first');
    await say(a, 'home', d, 'about the folder');
    const read1 = await share(a, 'home', d, m, 'read');
    const src = `share:${read1}`;
    expect(await texts(m, src, '/plan.txt')).toEqual(['owner first']);
    expect(await texts(m, src, '/')).toEqual(['about the folder']);
    const reply = await say(m, src, '/plan.txt', 'grantee answers');
    expect(reply).toMatchObject({ author: { id: m.id, displayName: 'Test Member' }, mine: true, canDelete: true });
    expect((await thread(a, 'home', `${d}/plan.txt`)).map((c) => [c.text, c.author.displayName, c.mine, c.canDelete])).toEqual([
      ['owner first', 'Test User', true, true], ['grantee answers', 'Test Member', false, true]]);
    expect((await thread(m, src, '/plan.txt')).map((c) => [c.mine, c.canDelete])).toEqual([[false, false], [true, true]]);
    // Counts per child, for the owner's folder and the grantee's view of it.
    expect(await counts(a, 'home', d)).toEqual({ [`${d}/plan.txt`]: 2 });
    expect(await counts(m, src, '/')).toEqual({ '/plan.txt': 2 });
    // A second grantee of the same item joins the thread.
    const second = await share(a, 'home', `${d}/plan.txt`, o, 'read');
    expect(await texts(o, `share:${second}`, '/')).toEqual(['owner first', 'grantee answers']);
  });

  it('are edited only by their author and deleted by their author or the item owner', async () => {
    const d = await fresh(a, 'rights');
    await put(a, `${d}/f.txt`);
    const src = `share:${await share(a, 'home', d, m, 'edit')}`;
    const mine = await say(a, 'home', `${d}/f.txt`, 'owner text');
    const theirs = await say(m, src, '/f.txt', 'member text');
    const keep = await say(m, src, '/f.txt', 'member keeps this');

    const edited = await edit(m, theirs.id, src, '/f.txt', '  member text, fixed ');
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ id: theirs.id, text: 'member text, fixed', created: theirs.created });
    expect(Date.parse((edited.json() as Comment).edited!)).not.toBeNaN();
    expect((await edit(m, theirs.id, src, '/f.txt', '')).json().code).toBe('COMMENT_INVALID');
    // The grantee neither edits nor deletes the owner's comment; the owner does not edit the member's.
    for (const r of [await edit(m, mine.id, src, '/f.txt', 'x'), await remove(m, mine.id, src, '/f.txt'),
      await edit(a, keep.id, 'home', `${d}/f.txt`, 'x')]) {
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().code).toBe('FORBIDDEN');
    }
    // A comment of another item is not found through this one.
    await put(a, `${d}/g.txt`);
    expect((await remove(a, keep.id, 'home', `${d}/g.txt`)).statusCode).toBe(404);
    // The owner deletes the member's comment; the member deletes their own.
    expect((await remove(a, theirs.id, 'home', `${d}/f.txt`)).statusCode).toBe(204);
    expect((await remove(m, keep.id, src, '/f.txt')).statusCode).toBe(204);
    expect(await texts(a, 'home', `${d}/f.txt`)).toEqual(['owner text']);
    expect((await remove(a, keep.id, 'home', `${d}/f.txt`)).statusCode).toBe(404);
  });

  it('revoking a share hides the thread from the grantee on the next request', async () => {
    const d = await fresh(a, 'revoke');
    await put(a, `${d}/f.txt`);
    const id = await share(a, 'home', d, m, 'edit');
    const c = await say(m, `share:${id}`, '/f.txt', 'before the revoke');
    expect(await texts(m, `share:${id}`, '/f.txt')).toEqual(['before the revoke']);
    await ok(as(a, 'DELETE', `/api/v1/shares/${id}`));
    for (const r of [await read(m, `share:${id}`, '/f.txt'), await post(m, `share:${id}`, '/f.txt', 'after'),
      await edit(m, c.id, `share:${id}`, '/f.txt', 'after'), await remove(m, c.id, `share:${id}`, '/f.txt'),
      await as(m, 'GET', `/api/v1/comments/folder?${q(`share:${id}`, '/')}`)]) {
      expect(r.statusCode, r.body).toBe(404);
    }
    // The owner keeps the thread.
    expect(await texts(a, 'home', `${d}/f.txt`)).toEqual(['before the revoke']);
  });

  it('follow renames and moves in the home, also a grantee\'s move inside the share', async () => {
    const d = await fresh(a, 'follow');
    await mkdir(a, `${d}/inner`);
    await mkdir(a, `${d}/sub`);
    await put(a, `${d}/inner/deep.txt`);
    await put(a, `${d}/f.txt`);
    await say(a, 'home', `${d}/f.txt`, 'on f');
    await say(a, 'home', `${d}/inner/deep.txt`, 'on deep');
    await move(a, `${d}/f.txt`, `${d}/renamed.txt`);
    await move(a, `${d}/inner`, `${d}/sub/inner`);
    expect(await texts(a, 'home', `${d}/renamed.txt`)).toEqual(['on f']);
    expect(await texts(a, 'home', `${d}/sub/inner/deep.txt`)).toEqual(['on deep']);
    // A new item under the old name starts without comments.
    await put(a, `${d}/f.txt`);
    expect(await texts(a, 'home', `${d}/f.txt`)).toEqual([]);

    const src = `share:${await share(a, 'home', d, m, 'edit')}`;
    await move(m, '/renamed.txt', '/sub/by-member.txt', src);
    expect(await texts(a, 'home', `${d}/sub/by-member.txt`)).toEqual(['on f']);
    expect(await texts(m, src, '/sub/by-member.txt')).toEqual(['on f']);
  });

  it('go to the trash with their item, come back with its restore and are deleted with it for good', async () => {
    const d = await fresh(a, 'trash');
    await mkdir(a, `${d}/f`);
    await put(a, `${d}/f/deep.txt`);
    await put(a, `${d}/single.txt`);
    await say(a, 'home', `${d}/f/deep.txt`, 'deep');
    await say(a, 'home', `${d}/single.txt`, 'single');
    await del(a, [`${d}/f`, `${d}/single.txt`]);
    // While the item is in the trash a new item at its path has an empty thread.
    await put(a, `${d}/single.txt`, 'new');
    expect(await texts(a, 'home', `${d}/single.txt`)).toEqual([]);
    await move(a, `${d}/single.txt`, `${d}/other.txt`);
    expect(rows(`${d}/single.txt`)).toBe(1);

    const trash = (await as(a, 'GET', '/api/v1/trash')).json().items as { id: string; originalPath: string }[];
    const idOf = (p: string) => trash.find((x) => x.originalPath === p)!.id;
    await ok(as(a, 'POST', '/api/v1/trash/restore', { id: idOf(`${d}/f`), onCollision: 'fail' }));
    expect(await texts(a, 'home', `${d}/f/deep.txt`)).toEqual(['deep']);
    await ok(as(a, 'POST', '/api/v1/trash/delete', { ids: [idOf(`${d}/single.txt`)] }));
    expect(rows(`${d}/single.txt`)).toBe(0);
  });

  it('of an item deleted outside the app give way to an item moved onto its path', async () => {
    const d = await fresh(a, 'outside');
    await put(a, `${d}/gone.txt`);
    await put(a, `${d}/mover.txt`);
    await say(a, 'home', `${d}/gone.txt`, 'stale');
    rmSync(join(homeRoot(t.config.dataDir, a.id), d, 'gone.txt'));
    await move(a, `${d}/mover.txt`, `${d}/gone.txt`);
    expect(await texts(a, 'home', `${d}/gone.txt`)).toEqual([]);
  });

  it('on a cloud item are kept in Files, shared with the item, follow moves and deletes, and go with the connection', async () => {
    const id = await connect(a);
    const conn = `conn:${id}`;
    await say(a, conn, '/Docs/a.txt', 'cloud note');
    await say(a, conn, '/Docs/b.txt', 'on b');
    await say(a, conn, '/top.txt', 'on top');
    const src = `share:${await share(a, conn, '/Docs', m, 'edit')}`;
    expect(await texts(m, src, '/a.txt')).toEqual(['cloud note']);
    await say(m, src, '/a.txt', 'member on cloud');
    expect(await counts(a, conn, '/Docs')).toEqual({ '/Docs/a.txt': 2, '/Docs/b.txt': 1 });
    expect(await counts(m, src, '/')).toEqual({ '/a.txt': 2, '/b.txt': 1 });

    // The grantee's rename inside the share and the owner's own move both carry the thread.
    await move(m, '/a.txt', '/renamed.txt', src);
    expect(await texts(a, conn, '/Docs/renamed.txt')).toEqual(['cloud note', 'member on cloud']);
    await move(a, '/Docs/renamed.txt', '/moved.txt', conn);
    expect(await texts(a, conn, '/moved.txt')).toEqual(['cloud note', 'member on cloud']);
    expect(rows('/Docs/a.txt') + rows('/Docs/renamed.txt')).toBe(0);
    // A delete through the app (into the provider's trash, outside Files) deletes the thread, also through the share.
    await del(m, ['/b.txt'], src);
    expect(rows('/Docs/b.txt')).toBe(0);
    await del(a, ['/moved.txt'], conn);
    expect(rows('/moved.txt')).toBe(0);
    // So does a transfer job that moves the item into the home (a copy, then a delete of the original).
    await say(a, conn, '/Docs/c.txt', 'on c');
    const target = await fresh(a, 'moved-in');
    const job = (await ok(as(a, 'POST', '/api/v1/transfers', { mode: 'move', from: conn, to: 'home', dir: target,
      items: [{ path: '/Docs/c.txt', onCollision: 'fail' }] }))).json() as { id: string };
    for (const end = Date.now() + 10_000; ;) {
      const status = (await as(a, 'GET', `/api/v1/transfers/${job.id}`)).json().status as string;
      if (status !== 'running') { expect(status).toBe('completed'); break; }
      if (Date.now() > end) throw new Error('transfer did not finish');
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(rows('/Docs/c.txt')).toBe(0);
    expect(await texts(a, 'home', `${target}/c.txt`)).toEqual([]);
    // Unlinking the connection deletes the threads of its items.
    expect(rows('/top.txt')).toBe(1);
    await ok(as(a, 'DELETE', `/api/v1/connections/${id}`));
    expect(rows('/top.txt')).toBe(0);
  });
});

// #308: comments sit outside every quota, so their number is capped: 500 live comments per item, 20 000 per author
// (also those waiting in the trash). The caps are checked with the insert in one transaction; a refused comment adds no row.
describe('comment limits', () => {
  const fill = (owner: string, path: string, author: string, count: number, trash: string | null = null) => {
    const ins = t.db.prepare(`INSERT INTO comments (owner_id, source, path, author_id, text, created_at, trash_id)
      VALUES (?, 'home', ?, ?, 'filler', '2026-10-18T00:00:00.000Z', ?)`);
    t.db.transaction(() => { for (let i = 0; i < count; i++) ins.run(owner, path, author, trash); })();
  };
  const limited = (r: { statusCode: number; body: string; json: () => unknown }, max: number) => {
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ code: 'COMMENT_LIMIT', params: { max } });
  };

  it('refuse the 501st live comment on an item, also from a read-only grantee, until the owner deletes one', async () => {
    const d = await fresh(a, 'item-limit');
    const path = `${d}/plan.txt`;
    await put(a, path);
    const src = `share:${await share(a, 'home', d, m, 'read')}`;
    // Trashed rows at the same path are not the live thread and do not count.
    fill(a.id, path, a.id, 30, 'trash-308');
    fill(a.id, path, a.id, 499);
    const last = await say(m, src, '/plan.txt', 'the 500th');
    const before = rows(path);
    limited(await post(m, src, '/plan.txt', 'one too many'), 500);
    limited(await post(a, 'home', path, 'one too many'), 500);
    expect(rows(path)).toBe(before);
    // The owner deletes any comment on their item, which makes room for one more.
    expect((await remove(a, last.id, 'home', path)).statusCode).toBe(204);
    await say(m, src, '/plan.txt', 'fits again');
    limited(await post(m, src, '/plan.txt', 'full again'), 500);
    expect(rows(path)).toBe(before);
  });

  it('refuse a member\'s 20 001st comment wherever it goes, trashed ones included, and hold nobody else to it', async () => {
    const d = await fresh(a, 'author-limit');
    const path = `${d}/plan.txt`;
    await put(a, path);
    const src = `share:${await share(a, 'home', d, m, 'read')}`;
    const bulk = `/bulk-308-${n}`;
    const own = `/own-308-${n}.txt`;
    // Top the member up to 19 998 comments (they wrote some in earlier tests), spread over many items of their own.
    const had = t.db.prepare('SELECT count(*) FROM comments WHERE author_id = ?').pluck().get(m.id) as number;
    for (let left = 19_998 - had, i = 0; left > 0; left -= 400, i++) fill(m.id, `${bulk}/${i}.txt`, m.id, Math.min(400, left));
    try {
      // The 19 999th goes on a file of their own, which they then delete: the comment waits in the trash with it and
      // still counts, so trashing an item does not reset the member's count while its rows stay in the database.
      await put(m, own);
      await say(m, 'home', own, 'the 19 999th');
      await del(m, [own]);
      expect(t.db.prepare('SELECT count(*) FROM comments WHERE path = ? AND trash_id IS NOT NULL').pluck().get(own)).toBe(1);
      await say(m, src, '/plan.txt', 'the 20 000th');
      limited(await post(m, src, '/plan.txt', 'one too many'), 20000);
      expect(rows(path)).toBe(1);
      await say(a, 'home', path, 'the owner still comments');
      expect(rows(path)).toBe(2);
      // Deleting the item from the trash for good deletes its comment, which makes room for one more.
      const trash = (await as(m, 'GET', '/api/v1/trash')).json().items as { id: string; originalPath: string }[];
      await ok(as(m, 'POST', '/api/v1/trash/delete', { ids: [trash.find((x) => x.originalPath === own)!.id] }));
      await say(m, src, '/plan.txt', 'fits again');
      limited(await post(m, src, '/plan.txt', 'full again'), 20000);
    } finally {
      t.db.prepare('DELETE FROM comments WHERE author_id = ? AND (substr(path, 1, length(?)) = ? OR path IN (?, ?))').run(m.id, bulk, bulk, own, path);
    }
  });

  it('count all of an author\'s comments through an index, not a scan of every comment', () => {
    const plan = t.db.prepare('EXPLAIN QUERY PLAN SELECT count(*) FROM comments WHERE author_id = ?')
      .all('someone') as { detail: string }[];
    expect(plan.map((p) => p.detail).join('\n')).toMatch(/USING (COVERING )?INDEX comments_author/);
  });
});
