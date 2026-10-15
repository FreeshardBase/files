import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { basic, createAppPassword, multistatus } from './support/dav.ts';

// Round trip over a real socket (#157): upload a tree, list it, download it, compare. rclone does it where it is
// installed; the scripted client below does the same with plain WebDAV requests, so the check runs everywhere.
const run = promisify(execFile);
let t: TestApp; let pw: string; let base: string; let work: string; let tree: string;

/** A tree with nested folders, names that need encoding, an empty file and a file larger than one read chunk. */
function makeTree(dir: string) {
  const files: Record<string, Buffer> = {
    'readme.txt': Buffer.from('hello'),
    'empty.bin': Buffer.alloc(0),
    'Fotos 2026/Strand & Meer #1.jpg': randomBytes(300_000),
    'Fotos 2026/Ä Ö Ü/ß%.txt': Buffer.from('umlauts'),
    'deep/a/b/c/d.dat': randomBytes(70_000),
  };
  for (const [p, data] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), data);
  }
  return files;
}
function digestTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}
const hasRclone = await run('rclone', ['version']).then(() => true, () => false);

beforeAll(async () => {
  t = await startTestApp();
  pw = await createAppPassword(t, await login(t));
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/dav`;
  work = mkdtempSync(join(tmpdir(), 'files-dav-rt-'));
  tree = join(work, 'tree');
  makeTree(tree);
});
// fetch resolves once Content-Length bytes are in, so the last response may still be finishing on the server when the
// test ends; its keep-alive socket would then hold close() open for Fastify's 72 s keep-alive. The client is done here.
afterAll(async () => {
  t.app.server.closeAllConnections();
  await t.close();
  rmSync(work, { recursive: true, force: true });
});

describe('WebDAV round trip', () => {
  it.skipIf(!hasRclone)('rclone uploads a tree, lists it, downloads it unchanged', async () => {
    const obscured = (await run('rclone', ['obscure', pw])).stdout.trim();
    const env = { ...process.env, RCLONE_CONFIG: join(work, 'none.conf'), RCLONE_CONFIG_FS_TYPE: 'webdav',
      RCLONE_CONFIG_FS_URL: `${base}/`, RCLONE_CONFIG_FS_VENDOR: 'other', RCLONE_CONFIG_FS_USER: 'testuser', RCLONE_CONFIG_FS_PASS: obscured };
    const rclone = (...args: string[]) => run('rclone', [...args, '--retries', '1', '--low-level-retries', '1'], { env });
    await rclone('copy', tree, 'fs:rclone-tree');
    const listed = JSON.parse((await rclone('lsjson', '-R', '--files-only', 'fs:rclone-tree')).stdout) as { Path: string; Size: number }[];
    expect(Object.fromEntries(listed.map((e) => [e.Path, e.Size]))).toEqual(
      Object.fromEntries(Object.entries(digestTree(tree)).map(([p]) => [p, statSync(join(tree, p)).size])));
    await rclone('check', tree, 'fs:rclone-tree', '--download');
    const back = join(work, 'rclone-back');
    await rclone('copy', 'fs:rclone-tree', back);
    expect(digestTree(back)).toEqual(digestTree(tree));
    // A second run finds nothing to do, so sizes and times round-trip too.
    const again = await rclone('copy', tree, 'fs:rclone-tree', '-v');
    expect(again.stderr).toMatch(/There was nothing to transfer|Transferred:\s+0 B/);
  }, 60_000);

  it('a scripted client (MKCOL, PUT, PROPFIND, GET) uploads a tree and downloads it unchanged', async () => {
    const auth = { authorization: basic(pw) };
    const enc = (rel: string) => rel.split('/').map(encodeURIComponent).join('/');
    const upload = async (dir: string, rel: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name); const r = rel ? `${rel}/${name}` : name;
        if (statSync(p).isDirectory()) {
          expect((await fetch(`${base}/script/${enc(r)}`, { method: 'MKCOL', headers: auth })).status).toBe(201);
          await upload(p, r);
        } else {
          expect((await fetch(`${base}/script/${enc(r)}`, { method: 'PUT', headers: auth, body: readFileSync(p) })).status).toBe(201);
        }
      }
    };
    expect((await fetch(`${base}/script`, { method: 'MKCOL', headers: auth })).status).toBe(201);
    await upload(tree, '');
    const back = join(work, 'script-back');
    const download = async (href: string, local: string) => {
      const res = await fetch(`${base.replace(/\/dav$/, '')}${href}`, { method: 'PROPFIND', headers: { ...auth, depth: '1' } });
      expect(res.status).toBe(207);
      const [self, ...children] = multistatus(await res.text());
      expect(self!.href).toBe(href);
      mkdirSync(local, { recursive: true });
      for (const c of children) {
        const name = decodeURIComponent(c.href.replace(/\/$/, '').split('/').at(-1)!);
        if (c.href.endsWith('/')) { await download(c.href, join(local, name)); continue; }
        const get = await fetch(`${base.replace(/\/dav$/, '')}${c.href}`, { headers: auth });
        expect(get.status).toBe(200);
        writeFileSync(join(local, name), Buffer.from(await get.arrayBuffer()));
      }
    };
    await download('/dav/script/', back);
    expect(existsSync(join(back, 'Fotos 2026', 'Ä Ö Ü', 'ß%.txt'))).toBe(true);
    expect(digestTree(back)).toEqual(digestTree(tree));
  });
});
