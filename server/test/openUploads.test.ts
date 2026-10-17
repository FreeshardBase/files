import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { homeRoot } from '../src/paths.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// #233: after a reload the upload panel lists the member's unfinished uploads (`GET /api/v1/uploads`), so one can be
// resumed by picking the file again or discarded, which frees what it reserves of the quota. Only the member's own
// uploads into their home are listed: never another member's, and never a visitor's upload through a file request.

let t: TestApp; let a: { cookie: string; csrf: string }; let b: { cookie: string; csrf: string };
const ORIGIN = 'https://files.example.com';
const MB = 1024 ** 2;
beforeAll(async () => {
  t = await startTestApp();
  a = await login(t, 'testuser');
  b = await login(t, 'member');
  for (const s of [a, b]) {
    const id = (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id as string;
    mkdirSync(homeRoot(t.config.dataDir, id), { recursive: true });
  }
});
afterAll(() => t.close());

type S = { cookie: string; csrf: string };
const b64 = (s: string) => Buffer.from(s).toString('base64');
const meta = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `${k} ${b64(v)}`).join(',');
const auth = (s: S) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN, 'tus-resumable': '1.0.0' });
async function create(path: string, length: number, s: S = a): Promise<string> {
  const r = await t.app.inject({ method: 'POST', url: '/api/v1/uploads',
    headers: { ...auth(s), 'upload-length': String(length), 'upload-metadata': meta({ source: 'home', path }) } });
  expect(r.statusCode, r.body).toBe(201);
  return String(r.headers.location).split('/').pop()!;
}
async function patch(id: string, offset: number, body: Buffer, s: S = a) {
  const r = await t.app.inject({ method: 'PATCH', url: `/api/v1/uploads/${id}`, payload: body,
    headers: { ...auth(s), 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' } });
  expect(r.statusCode, r.body).toBe(204);
}
const list = async (s: S = a) => {
  const r = await t.app.inject({ url: '/api/v1/uploads', headers: { cookie: s.cookie } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().items as { id: string; path: string; length: number; offset: number; expiresAt: string }[];
};

describe('unfinished uploads', () => {
  it('lists the member\'s own open uploads with path, size and how much arrived; a finished one is gone', async () => {
    const half = await create('/Holiday/film.mov', 2 * MB);
    await patch(half, 0, Buffer.alloc(MB, 1));
    const done = await create('/done.txt', 2);
    await patch(done, 0, Buffer.from('ok'));
    const items = await list();
    expect(items).toEqual([expect.objectContaining({ id: half, path: '/Holiday/film.mov', length: 2 * MB, offset: MB })]);
    expect(Date.parse(items[0]!.expiresAt)).toBeGreaterThan(Date.now());
    expect(await list(b)).toEqual([]);
    expect((await t.app.inject({ url: '/api/v1/uploads' })).statusCode).toBe(401);
  });

  it('discarding one drops it from the list and frees the quota it reserved', async () => {
    const id = await create('/big.bin', 3 * MB, b);
    await patch(id, 0, Buffer.alloc(MB, 2), b);
    expect((await list(b)).map((u) => u.id)).toEqual([id]);
    // The admin gives the member a quota of 4 MB: the open upload reserves 3 MB of it, so another 2 MB do not fit.
    const memberId = (await t.app.inject({ url: '/api/v1/me', headers: { cookie: b.cookie } })).json().id as string;
    const q = await t.app.inject({ method: 'PUT', url: `/api/v1/admin/members/${memberId}/quota`,
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN }, payload: { quotaBytes: 4 * MB } });
    expect(q.statusCode, q.body).toBeLessThan(300);
    const refused = await t.app.inject({ method: 'POST', url: '/api/v1/uploads',
      headers: { ...auth(b), 'upload-length': String(2 * MB), 'upload-metadata': meta({ source: 'home', path: '/second.bin' }) } });
    expect(refused.json()).toEqual({ code: 'QUOTA_EXCEEDED' });

    const d = await t.app.inject({ method: 'DELETE', url: `/api/v1/uploads/${id}`, headers: auth(b) });
    expect(d.statusCode).toBe(204);
    expect(await list(b)).toEqual([]);
    const usage = (await t.app.inject({ url: '/api/v1/storage', headers: { cookie: b.cookie } })).json().home.usage;
    expect(usage.uploads).toBe(0);
    await create('/second.bin', 2 * MB, b);
  });

  it('a visitor\'s upload through the member\'s file request is not the member\'s to see or discard', async () => {
    const mk = await t.app.inject({ method: 'POST', url: '/api/v1/sources/home/mkdir',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN }, payload: { path: '/Inbox-233' } });
    expect(mk.statusCode, mk.body).toBe(201);
    const req = await t.app.inject({ method: 'POST', url: '/api/v1/requests',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN }, payload: { source: 'home', path: '/Inbox-233' } });
    expect(req.statusCode, req.body).toBe(201);
    const token = req.json().token as string;
    const ip = '198.51.100.9';
    const infoRes = await t.app.inject({ url: `/r/${token}/info`, remoteAddress: ip });
    const cookie = ([] as string[]).concat(infoRes.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]!).join('; ');
    const before = (await list()).length;
    const v = await t.app.inject({ method: 'POST', url: `/r/${token}/uploads`, remoteAddress: ip,
      headers: { cookie, origin: ORIGIN, 'tus-resumable': '1.0.0', 'upload-length': '10', 'upload-metadata': meta({ name: 'scan.pdf' }) } });
    expect(v.statusCode, v.body).toBe(201);
    expect(await list()).toHaveLength(before);
  });
});
