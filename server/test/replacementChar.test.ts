import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homeRoot } from '../src/paths.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { basic, createAppPassword } from './support/dav.ts';

// #379: a listing hides names containing U+FFFD (they stand for invalid UTF-8 on disk), so no write path may create one:
// otherwise a file request visitor or a member with `edit` plants files the owner never sees.

type S = { cookie: string; csrf: string };
let t: TestApp; let a: S; let pw: string; let root: string;
const ORIGIN = 'https://files.example.com';
const mutating = (s: S) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN });

beforeAll(async () => {
  t = await startTestApp();
  a = await login(t, 'testuser');
  pw = await createAppPassword(t, a);
  root = homeRoot(t.config.dataDir, (await t.app.inject({ url: '/api/v1/me', headers: { cookie: a.cookie } })).json().id);
});
afterAll(() => t.close());

const op = (name: string, payload: object) => t.app.inject({
  method: 'POST', url: `/api/v1/sources/home/${name}`, headers: mutating(a), payload });
const put = (path: string, text: string) => t.app.inject({
  method: 'PUT', url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=fail`,
  headers: { ...mutating(a), 'content-type': 'application/octet-stream' }, payload: Buffer.from(text) });
const list = async (path: string) => {
  const r = await t.app.inject({ url: `/api/v1/sources/home/list?path=${encodeURIComponent(path)}`, headers: { cookie: a.cookie } });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json().entries as { name: string }[]).map((e) => e.name).sort();
};

describe('names containing U+FFFD are refused on every write path (#379)', () => {
  it('PUT, mkdir, move and copy answer PATH_INVALID and create nothing; the listing shows what exists', async () => {
    expect((await op('mkdir', { path: '/probe' })).statusCode).toBe(201);
    const p = await put('/probe/report�.txt', 'hidden');
    expect(p.statusCode, p.body).toBe(400);
    expect(p.json()).toEqual({ code: 'PATH_INVALID' });
    expect(existsSync(join(root, 'probe', 'report�.txt'))).toBe(false);

    const d = await op('mkdir', { path: '/probe/dir�' });
    expect(d.statusCode, d.body).toBe(400);
    expect(d.json()).toEqual({ code: 'PATH_INVALID' });

    expect((await put('/probe/a.txt', 'a')).statusCode).toBe(201);
    const m = await op('move', { from: '/probe/a.txt', to: '/probe/b�.txt', onCollision: 'fail' });
    expect(m.statusCode, m.body).toBe(400);
    expect(m.json()).toEqual({ code: 'PATH_INVALID' });
    const c = await op('copy', { from: '/probe/a.txt', to: '/probe/c�.txt', onCollision: 'fail' });
    expect(c.statusCode, c.body).toBe(400);
    expect(c.json()).toEqual({ code: 'PATH_INVALID' });

    // Nothing hidden was planted: the disk holds exactly what the listing shows.
    expect(readdirSync(join(root, 'probe'))).toEqual(['a.txt']);
    expect(await list('/probe')).toEqual(['a.txt']);
  });

  it('WebDAV PUT and MOVE to such a name answer 400 and create nothing', async () => {
    const dav = (method: string, path: string, headers: Record<string, string> = {}, payload?: string) => t.app.inject({
      method: method as 'PUT', url: `/dav${path}`, payload, headers: { authorization: basic(pw), ...headers } });
    expect((await dav('MKCOL', '/davprobe')).statusCode).toBe(201);
    const p = await dav('PUT', '/davprobe/%EF%BF%BD.txt', {}, 'hidden');
    expect(p.statusCode, p.body).toBe(400);
    expect(existsSync(join(root, 'davprobe', '�.txt'))).toBe(false);

    expect((await dav('PUT', '/davprobe/a.txt', {}, 'a')).statusCode).toBe(201);
    const m = await dav('MOVE', '/davprobe/a.txt', { destination: `${ORIGIN}/dav/davprobe/b%EF%BF%BD.txt` });
    expect(m.statusCode, m.body).toBe(400);
    expect(readdirSync(join(root, 'davprobe'))).toEqual(['a.txt']);
    expect(await list('/davprobe')).toEqual(['a.txt']);
  });
});
