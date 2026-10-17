import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { homeRoot } from '../../src/paths.ts';
import type { StorageBackend } from '../../src/storage/backend.ts';
import { startTestApp, login, type TestApp } from '../support/harness.ts';
import { DROPBOX, GDRIVE, liveBackend, liveEnv, PCLOUD } from './providers.ts';

// Transfer jobs through the real app between the home and real clouds (LIVE_<P>_*, server/.env.live): a real Google
// Drive and a real Dropbox together, and a real pCloud (#211) on its own. Each suite is skipped, never passed, without its
// variables. Works in fresh folders that are deleted after.
const [gd, db, pc] = [liveEnv(GDRIVE), liveEnv(DROPBOX), liveEnv(PCLOUD)];
const MB = 1024 * 1024;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const ORIGIN = 'https://files.example.com';

async function bytes(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

type Job = { id: string; status: string; total: number; done: number; failed: { path: string; code: string }[] };

/** The app with `clouds` as testuser's connections (`conn:<key>`), each with a fresh folder; `run` starts a job and waits. */
function transferApp(clouds: () => Record<string, StorageBackend>, dir: string) {
  const ctx = {} as { t: TestApp; s: { cookie: string; csrf: string; id: string } };
  const as = (method: string, url: string, payload?: unknown) => ctx.t.app.inject({
    method: method as 'GET', url,
    headers: { cookie: ctx.s.cookie, ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': ctx.s.csrf }) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  async function run(o: { mode: 'copy' | 'move'; from: string; to: string; dir: string; paths: string[] }): Promise<Job> {
    const r = await as('POST', '/api/v1/transfers', { mode: o.mode, from: o.from, to: o.to, dir: o.dir,
      items: o.paths.map((path) => ({ path, onCollision: 'fail' })) });
    expect(r.statusCode, r.body).toBe(201);
    const id = (r.json() as Job).id;
    const end = Date.now() + 10 * 60_000;
    for (;;) {
      const j = (await as('GET', `/api/v1/transfers/${id}`)).json() as Job;
      if (j.status !== 'running' && j.status !== 'queued') return j;
      if (Date.now() > end) throw new Error(`job ${id} still ${j.status}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  beforeAll(async () => {
    const backends = clouds();
    ctx.t = await startTestApp({}, undefined, undefined,
      { connections: async () => Object.entries(backends).map(([id, backend]) => ({ id, backend })) });
    const l = await login(ctx.t, 'testuser');
    ctx.s = { ...l, id: (await ctx.t.app.inject({ url: '/api/v1/me', headers: { cookie: l.cookie } })).json().id as string };
    for (const b of Object.values(backends)) await b.mkdir(dir);
  }, 120_000);
  afterAll(async () => {
    // Cleanup failures must show: a leftover folder in the user's cloud is a bug of this test.
    const results = await Promise.allSettled(Object.values(clouds()).map((b) => b.delete([dir])));
    await ctx.t.close();
    for (const r of results) if (r.status === 'rejected') throw r.reason;
  }, 120_000);
  return { run, home: () => homeRoot(ctx.t.config.dataDir, ctx.s.id) };
}

describe.skipIf(gd === undefined || db === undefined)('live: transfers between home, Google Drive and Dropbox', () => {
  let drive: StorageBackend; let box: StorageBackend;
  const tag = randomBytes(4).toString('hex');
  const dir = `/freeshard-files-transfer-${tag}`;
  const big = randomBytes(12 * MB + 777); const note = Buffer.from(`note ${tag} äöü`);
  const app = transferApp(() => {
    drive ??= liveBackend(GDRIVE, gd!).backend; box ??= liveBackend(DROPBOX, db!).backend;
    return { gd: drive, db: box };
  }, dir);

  it('home → Dropbox → Google Drive → home keeps every byte, then a move from Dropbox removes the source', { timeout: 20 * 60_000 }, async () => {
    const home = app.home();
    mkdirSync(join(home, 'out/sub'), { recursive: true });
    writeFileSync(join(home, 'out/big.bin'), big);
    writeFileSync(join(home, 'out/sub/note.txt'), note);

    expect(await app.run({ mode: 'copy', from: 'home', to: 'conn:db', dir, paths: ['/out'] }))
      .toMatchObject({ status: 'completed', failed: [] });
    expect(sha(await bytes((await box.read(`${dir}/out/big.bin`)).stream))).toBe(sha(big));

    expect(await app.run({ mode: 'copy', from: 'conn:db', to: 'conn:gd', dir, paths: [`${dir}/out`] }))
      .toMatchObject({ status: 'completed', failed: [] });
    expect((await bytes((await drive.read(`${dir}/out/sub/note.txt`)).stream)).equals(note)).toBe(true);

    mkdirSync(join(home, 'back'));
    expect(await app.run({ mode: 'copy', from: 'conn:gd', to: 'home', dir: '/back', paths: [`${dir}/out`] }))
      .toMatchObject({ status: 'completed', failed: [] });
    expect(sha(readFileSync(join(home, 'back/out/big.bin')))).toBe(sha(big));
    expect(readFileSync(join(home, 'back/out/sub/note.txt')).equals(note)).toBe(true);

    mkdirSync(join(home, 'moved'));
    expect(await app.run({ mode: 'move', from: 'conn:db', to: 'home', dir: '/moved', paths: [`${dir}/out/sub`] }))
      .toMatchObject({ status: 'completed', failed: [] });
    expect(readFileSync(join(home, 'moved/sub/note.txt')).equals(note)).toBe(true);
    await expect(box.stat(`${dir}/out/sub`)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe.skipIf(pc === undefined)('live: transfers between home and pCloud (#211)', () => {
  let cloud: StorageBackend;
  const tag = randomBytes(4).toString('hex');
  const dir = `/freeshard-files-transfer-${tag}`;
  const big = randomBytes(12 * MB + 777); const note = Buffer.from(`note ${tag} äöü`);
  const app = transferApp(() => { cloud ??= liveBackend(PCLOUD, pc!).backend; return { pc: cloud }; }, dir);

  it('home → pCloud → home keeps every byte, then a move from pCloud removes the source', { timeout: 20 * 60_000 }, async () => {
    const home = app.home();
    mkdirSync(join(home, 'out/sub'), { recursive: true });
    writeFileSync(join(home, 'out/big.bin'), big);
    writeFileSync(join(home, 'out/sub/note.txt'), note);

    expect(await app.run({ mode: 'copy', from: 'home', to: 'conn:pc', dir, paths: ['/out'] }))
      .toMatchObject({ status: 'completed', failed: [] });
    expect(sha(await bytes((await cloud.read(`${dir}/out/big.bin`)).stream))).toBe(sha(big));

    mkdirSync(join(home, 'back'));
    expect(await app.run({ mode: 'copy', from: 'conn:pc', to: 'home', dir: '/back', paths: [`${dir}/out`] }))
      .toMatchObject({ status: 'completed', failed: [] });
    expect(sha(readFileSync(join(home, 'back/out/big.bin')))).toBe(sha(big));
    expect(readFileSync(join(home, 'back/out/sub/note.txt')).equals(note)).toBe(true);

    mkdirSync(join(home, 'moved'));
    expect(await app.run({ mode: 'move', from: 'conn:pc', to: 'home', dir: '/moved', paths: [`${dir}/out/sub`] }))
      .toMatchObject({ status: 'completed', failed: [] });
    expect(readFileSync(join(home, 'moved/sub/note.txt')).equals(note)).toBe(true);
    await expect(cloud.stat(`${dir}/out/sub`)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
