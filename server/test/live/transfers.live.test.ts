import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { OAuthClient, systemClock, type Provider } from '../../src/cloud/oauth.ts';
import { googleDriveProvider } from '../../src/cloud/googleDrive.ts';
import { dropboxProvider } from '../../src/cloud/dropbox.ts';
import { homeRoot } from '../../src/paths.ts';
import type { StorageBackend } from '../../src/storage/backend.ts';
import { startTestApp, login, type TestApp } from '../support/harness.ts';

// Transfer jobs through the real app between the home, a real Google Drive and a real Dropbox (LIVE_GDRIVE_* and
// LIVE_DROPBOX_*, server/.env.live); skipped, never passed, without both. Works in fresh folders that are deleted after.
const env = (p: string) => ['REFRESH_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET'].map((v) => process.env[`LIVE_${p}_${v}`]);
const [gd, db] = [env('GDRIVE'), env('DROPBOX')];
const MB = 1024 * 1024;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const ORIGIN = 'https://files.example.com';

function backendOf(make: (c: { clientId: string; clientSecret: string }) => Provider, [refresh, clientId, clientSecret]: (string | undefined)[]) {
  const provider = make({ clientId: clientId!, clientSecret: clientSecret! });
  let stored = refresh!;
  const client = new OAuthClient(provider, { refreshToken: () => stored, saveRefreshToken: (t) => { stored = t; }, setStatus: () => undefined },
    systemClock);
  return provider.backend(client, '') as StorageBackend;
}
async function bytes(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

type Job = { id: string; status: string; total: number; done: number; failed: { path: string; code: string }[] };

describe.skipIf([...gd, ...db].some((v) => !v))('live: transfers between home, Google Drive and Dropbox', () => {
  let t: TestApp; let s: { cookie: string; csrf: string; id: string };
  let drive: StorageBackend; let box: StorageBackend;
  const tag = randomBytes(4).toString('hex');
  const gdDir = `/freeshard-files-transfer-${tag}`; const dbDir = `/freeshard-files-transfer-${tag}`;
  const big = randomBytes(12 * MB + 777); const note = Buffer.from(`note ${tag} äöü`);

  const as = (method: string, url: string, payload?: unknown) => t.app.inject({
    method: method as 'GET', url,
    headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': s.csrf }) },
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
    drive = backendOf(googleDriveProvider, gd); box = backendOf(dropboxProvider, db);
    t = await startTestApp({}, undefined, undefined, { connections: async () => [{ id: 'gd', backend: drive }, { id: 'db', backend: box }] });
    const l = await login(t, 'testuser');
    s = { ...l, id: (await t.app.inject({ url: '/api/v1/me', headers: { cookie: l.cookie } })).json().id as string };
    await drive.mkdir(gdDir); await box.mkdir(dbDir);
  }, 120_000);
  afterAll(async () => {
    // Cleanup failures must show: a leftover folder in the user's cloud is a bug of this test.
    const results = await Promise.allSettled([drive.delete([gdDir]), box.delete([dbDir])]);
    await t.close();
    for (const r of results) if (r.status === 'rejected') throw r.reason;
  }, 120_000);

  it('home → Dropbox → Google Drive → home keeps every byte, then a move from Dropbox removes the source', { timeout: 20 * 60_000 }, async () => {
    const home = homeRoot(t.config.dataDir, s.id);
    mkdirSync(join(home, 'out/sub'), { recursive: true });
    writeFileSync(join(home, 'out/big.bin'), big);
    writeFileSync(join(home, 'out/sub/note.txt'), note);

    expect(await run({ mode: 'copy', from: 'home', to: 'conn:db', dir: dbDir, paths: ['/out'] }))
      .toMatchObject({ status: 'completed', failed: [] });
    expect(sha(await bytes((await box.read(`${dbDir}/out/big.bin`)).stream))).toBe(sha(big));

    expect(await run({ mode: 'copy', from: 'conn:db', to: 'conn:gd', dir: gdDir, paths: [`${dbDir}/out`] }))
      .toMatchObject({ status: 'completed', failed: [] });
    expect((await bytes((await drive.read(`${gdDir}/out/sub/note.txt`)).stream)).equals(note)).toBe(true);

    mkdirSync(join(home, 'back'));
    expect(await run({ mode: 'copy', from: 'conn:gd', to: 'home', dir: '/back', paths: [`${gdDir}/out`] }))
      .toMatchObject({ status: 'completed', failed: [] });
    expect(sha(readFileSync(join(home, 'back/out/big.bin')))).toBe(sha(big));
    expect(readFileSync(join(home, 'back/out/sub/note.txt')).equals(note)).toBe(true);

    mkdirSync(join(home, 'moved'));
    expect(await run({ mode: 'move', from: 'conn:db', to: 'home', dir: '/moved', paths: [`${dbDir}/out/sub`] }))
      .toMatchObject({ status: 'completed', failed: [] });
    expect(readFileSync(join(home, 'moved/sub/note.txt')).equals(note)).toBe(true);
    await expect(box.stat(`${dbDir}/out/sub`)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
