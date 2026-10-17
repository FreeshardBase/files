import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { StorageBackend } from '../../src/storage/backend.ts';
import { startTestApp, login, type TestApp } from '../support/harness.ts';
import { DROPBOX, GDRIVE, liveBackend, liveEnv, PCLOUD } from './providers.ts';

// Internal shares and public links on a real Google Drive, Dropbox and pCloud (LIVE_<P>_*, server/.env.live), driven
// through the real app: the owner (testuser) has the connection, the member reaches it only through the share, the
// visitor only through the link. Skipped, never passed, without the variables. Works in a fresh folder, deleted after.
const PROVIDERS = [GDRIVE, DROPBOX, PCLOUD];
const ORIGIN = 'https://files.example.com';
type S = { cookie: string; csrf: string };
type Res = { statusCode: number; body: string; headers: Record<string, unknown>; json: () => unknown };

async function bytes(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

for (const p of PROVIDERS) {
  const env = liveEnv(p);
  describe.skipIf(env === undefined)(`live sharing: ${p.name} (LIVE_${p.prefix}_*)`, () => {
    let t: TestApp; let owner: S; let member: S; let ownerId = ''; let memberId = '';
    let b: StorageBackend;
    const dir = `/freeshard-files-sharing-${randomBytes(4).toString('hex')}`;
    const note = Buffer.from(`shared note ${dir}`);
    const deep = Buffer.from('deep file');

    const src = (source: string) => `/api/v1/sources/${encodeURIComponent(source)}`;
    const mut = (s: S) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN });
    const get = (s: S, url: string) => t.app.inject({ url, headers: { cookie: s.cookie } }) as Promise<Res>;
    const post = (s: S, url: string, payload: unknown) =>
      t.app.inject({ method: 'POST', url, headers: mut(s), payload: payload as object }) as Promise<Res>;
    const put = (s: S, source: string, path: string, body: Buffer) => t.app.inject({ method: 'PUT',
      url: `${src(source)}/content?path=${encodeURIComponent(path)}&onCollision=fail`,
      headers: { ...mut(s), 'content-type': 'application/octet-stream' }, payload: body }) as Promise<Res>;
    const visit = (token: string, rest: string, headers: Record<string, string> = {}) =>
      t.app.inject({ url: `/s/${token}/${rest}`, remoteAddress: '198.51.100.9', headers }) as Promise<Res>;
    const ok = (r: Res) => { expect(r.statusCode, r.body).toBeLessThan(300); return r; };
    const noProviderLeak = (r: Res) => {
      const text = `${JSON.stringify(r.headers)} ${r.headers['content-type']?.toString().includes('json') ? r.body : ''}`;
      expect(text).not.toMatch(/googleapis|googleusercontent|dropbox(usercontent|api)?\.com|pcloud\.com|access_token|Bearer/i);
      expect(r.headers.location).toBeUndefined();
    };

    beforeAll(async () => {
      b = liveBackend(p, env!).backend;
      t = await startTestApp({}, undefined, undefined,
        { connections: async (u) => (u.id === ownerId ? [{ id: 'cloud', backend: b }] : []) });
      owner = await login(t, 'testuser'); member = await login(t, 'member');
      ownerId = ((await get(owner, '/api/v1/me')).json() as { id: string }).id;
      memberId = ((await get(member, '/api/v1/me')).json() as { id: string }).id;
      await b.mkdir(dir); await b.mkdir(`${dir}/sub`);
      await b.write(`${dir}/note.txt`, Readable.from([note]), { onCollision: 'fail', maxBytes: 1 << 20, size: note.length });
      await b.write(`${dir}/sub/deep.txt`, Readable.from([deep]), { onCollision: 'fail', maxBytes: 1 << 20, size: deep.length });
    }, 120_000);
    afterAll(async () => {
      // A leftover folder in the user's cloud would be a bug of this test, so a failed cleanup fails the run.
      try { await b.delete([dir]); } finally { await t.close(); }
    }, 120_000);

    it('read share of a folder: the member lists and downloads, every write is 403 and changes nothing', { timeout: 300_000 }, async () => {
      const r = ok(await post(owner, '/api/v1/shares', { source: 'conn:cloud', path: dir, grantee: memberId, access: 'read' }));
      const source = `share:${(r.json() as { id: string }).id}`;
      expect(((await get(member, '/api/v1/shares/incoming')).json() as { items: { id: string }[] }).items.length).toBeGreaterThan(0);
      const list = ok(await get(member, `${src(source)}/list?path=%2F`)).json() as { entries: { name: string }[] };
      expect(list.entries.map((e) => e.name).sort()).toEqual(['note.txt', 'sub']);
      const dl = ok(await get(member, `${src(source)}/content?path=%2Fnote.txt`));
      noProviderLeak(dl);
      expect(dl.body).toBe(note.toString());
      expect((await put(member, source, '/new.txt', Buffer.from('x'))).statusCode).toBe(403);
      expect((await post(member, `${src(source)}/mkdir`, { path: '/made' })).statusCode).toBe(403);
      expect((await post(member, `${src(source)}/delete`, { paths: ['/note.txt'] })).statusCode).toBe(403);
      await expect(b.stat(`${dir}/new.txt`)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await b.stat(`${dir}/note.txt`)).size).toBe(note.length);
    });

    it('edit share of a folder: the member writes, renames and deletes, and it lands in the owner\'s cloud', { timeout: 300_000 }, async () => {
      const r = ok(await post(owner, '/api/v1/shares', { source: 'conn:cloud', path: `${dir}/sub`, grantee: memberId, access: 'edit' }));
      const source = `share:${(r.json() as { id: string }).id}`;
      const up = Buffer.from('written by the member');
      ok(await put(member, source, '/from-member.txt', up));
      expect((await bytes((await b.read(`${dir}/sub/from-member.txt`)).stream)).equals(up)).toBe(true);
      ok(await post(member, `${src(source)}/mkdir`, { path: '/made' }));
      expect((await b.stat(`${dir}/sub/made`)).type).toBe('directory');
      ok(await post(member, `${src(source)}/move`, { from: '/from-member.txt', to: '/made/renamed.txt', onCollision: 'fail' }));
      expect((await b.stat(`${dir}/sub/made/renamed.txt`)).size).toBe(up.length);
      ok(await post(member, `${src(source)}/delete`, { paths: ['/made'] }));
      await expect(b.stat(`${dir}/sub/made`)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // Nothing above the shared folder is reachable.
      expect((await get(member, `${src(source)}/content?path=${encodeURIComponent('/../note.txt')}`)).statusCode).toBeGreaterThanOrEqual(400);
    });

    it('read share of a single file opens the file itself', { timeout: 300_000 }, async () => {
      const r = ok(await post(owner, '/api/v1/shares', { source: 'conn:cloud', path: `${dir}/note.txt`, grantee: memberId, access: 'read' }));
      const source = `share:${(r.json() as { id: string }).id}`;
      expect(ok(await get(member, `${src(source)}/content?path=%2F`)).body).toBe(note.toString());
    });

    it('public link to a file: the visitor downloads through the shard, with Range; a limit of 2 is enforced', { timeout: 300_000 }, async () => {
      const l = ok(await post(owner, '/api/v1/links', { source: 'conn:cloud', path: `${dir}/note.txt`, maxDownloads: 2 }))
        .json() as { token: string };
      const info = ok(await visit(l.token, 'info'));
      noProviderLeak(info);
      const whole = ok(await visit(l.token, 'content'));
      noProviderLeak(whole);
      expect(whole.body).toBe(note.toString());
      const part = await visit(l.token, 'content', { range: 'bytes=0-5' });
      expect(part.statusCode).toBe(206);
      expect(part.body).toBe(note.subarray(0, 6).toString());
      expect((await visit(l.token, 'content')).statusCode).toBeGreaterThanOrEqual(400);
    });

    it('public link to a folder: the visitor browses into a subfolder and downloads, never above the folder', { timeout: 300_000 }, async () => {
      const l = ok(await post(owner, '/api/v1/links', { source: 'conn:cloud', path: `${dir}/sub` })).json() as { token: string };
      const top = ok(await visit(l.token, 'list')).json() as { entries: { name: string }[] };
      expect(top.entries.map((e) => e.name)).toContain('deep.txt');
      const dl = ok(await visit(l.token, 'content?path=%2Fdeep.txt'));
      noProviderLeak(dl);
      expect(dl.body).toBe(deep.toString());
      expect((await visit(l.token, `content?path=${encodeURIComponent('/../note.txt')}`)).statusCode).toBeGreaterThanOrEqual(400);
    });

    it('public link with a password: nothing before unlocking, the bytes after', { timeout: 300_000 }, async () => {
      const l = ok(await post(owner, '/api/v1/links', { source: 'conn:cloud', path: `${dir}/note.txt`, password: 'correct horse battery' }))
        .json() as { token: string };
      expect((await visit(l.token, 'content')).json()).toEqual({ code: 'PASSWORD_REQUIRED' });
      const u = await t.app.inject({ method: 'POST', url: `/s/${l.token}/unlock`, remoteAddress: '198.51.100.9',
        headers: { origin: ORIGIN }, payload: { password: 'correct horse battery' } });
      expect(u.statusCode, u.body).toBeLessThan(300);
      const cookie = String(u.headers['set-cookie']).split(';')[0]!;
      expect(ok(await visit(l.token, 'content', { cookie })).body).toBe(note.toString());
    });
  });
}
