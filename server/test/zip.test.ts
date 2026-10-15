import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWriteStream, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import type { Entry } from '@files/shared';
import { AppError } from '../src/errors.ts';
import { homeRoot } from '../src/paths.ts';
import type { StorageBackend } from '../src/storage/backend.ts';
import { zipStream } from '../src/storage/zip.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';

// #139 (absorbs #97: every folder ZIP download returned 500). The archive is fetched over a real socket and unpacked
// with yauzl, an independent reader; every file is compared byte for byte and against its CRC.

let t: TestApp; let a: { cookie: string; csrf: string }; let root: string; let port: number;
const ORIGIN = 'https://files.example.com';
const scratch = mkdtempSync(join(tmpdir(), 'files-zip-test-'));
beforeAll(async () => {
  t = await startTestApp();
  a = await login(t, 'testuser');
  const userId = (await t.app.inject({ url: '/api/v1/me', headers: { cookie: a.cookie } })).json().id;
  root = homeRoot(t.config.dataDir, userId);
  mkdirSync(root, { recursive: true });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  port = (t.app.server.address() as AddressInfo).port;
});
afterAll(async () => { await t.close(); rmSync(scratch, { recursive: true, force: true }); });

let n = 0;
const fresh = (stem: string) => { const d = `/${stem}-${++n}`; mkdirSync(join(root, d), { recursive: true }); return d; };
const put = (path: string, data: string | Buffer) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), data); };
const zipUrl = (...paths: string[]) => `/api/v1/sources/home/zip?${paths.map((p) => `path=${encodeURIComponent(p)}`).join('&')}`;

function get(url: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, headers: { cookie: a.cookie } }, resolve).on('error', reject);
  });
}

type Unpacked = { name: string; flags: number; crc: number; size: number; data: Buffer; dir: boolean };
async function unzip(file: string): Promise<Unpacked[]> {
  const zip = await new Promise<yauzl.ZipFile>((res, rej) => yauzl.open(file, { lazyEntries: true }, (e, z) => (e ? rej(e) : res(z!))));
  const out: Unpacked[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', () => resolve());
    zip.on('entry', (entry: yauzl.Entry) => {
      const dir = entry.fileName.endsWith('/');
      const base = { name: entry.fileName, flags: entry.generalPurposeBitFlag, crc: entry.crc32, size: entry.uncompressedSize, dir };
      if (dir) { out.push({ ...base, data: Buffer.alloc(0) }); zip.readEntry(); return; }
      zip.openReadStream(entry, (e, s) => {
        if (e) return reject(e);
        const parts: Buffer[] = [];
        s.on('data', (c: Buffer) => parts.push(c));
        s.on('error', reject);
        s.on('end', () => { out.push({ ...base, data: Buffer.concat(parts) }); zip.readEntry(); });
      });
    });
    zip.readEntry();
  });
  return out;
}
async function download(...paths: string[]) {
  const res = await get(zipUrl(...paths));
  const file = join(scratch, `${++n}.zip`);
  await pipeline(res, createWriteStream(file));
  return { res, entries: res.statusCode === 200 ? await unzip(file) : [] };
}

describe('folder and selection as a streamed ZIP (#139, #97)', () => {
  it('a nested folder unpacks byte for byte, with relative UTF-8 names and its empty folders', async () => {
    const d = fresh('nested');
    const files: Record<string, Buffer> = {
      'a b.txt': Buffer.from('space'),
      'Prüfung #1 50% & ü.md': Buffer.from('unicode'),
      "sub dir/it's \"quoted\" (1).bin": Buffer.from([0, 1, 2, 255, 254, 10, 13]),
      'sub dir/deeper/🎉.dat': Buffer.alloc(300_000, 7),
      'sub dir/deeper/random.bin': Buffer.from(Array.from({ length: 100_000 }, (_, i) => (i * 7919) % 251)),
      'leer.txt': Buffer.alloc(0),
    };
    for (const [rel, data] of Object.entries(files)) put(`${d}/${rel}`, data);
    mkdirSync(join(root, d, 'empty'));
    const { res, entries } = await download(d);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const top = d.slice(1);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${top}.zip"; filename*=UTF-8''${top}.zip`);
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect([...byName.keys()].sort()).toEqual([
      `${top}/`, `${top}/empty/`, `${top}/sub dir/`, `${top}/sub dir/deeper/`,
      ...Object.keys(files).map((rel) => `${top}/${rel}`),
    ].sort());
    for (const [rel, data] of Object.entries(files)) {
      const e = byName.get(`${top}/${rel}`)!;
      expect(Buffer.compare(e.data, data), rel).toBe(0);
      expect(e.crc, rel).toBe(crc32(data));
      expect(e.size, rel).toBe(data.length);
    }
    for (const e of entries) expect(e.flags & 0x800, `${e.name} has the UTF-8 flag`).toBe(0x800);
  });

  it('a selection of two files and a folder in one folder becomes one archive named after that folder', async () => {
    const d = fresh('sel');
    put(`${d}/one.txt`, 'one'); put(`${d}/two.txt`, 'two'); put(`${d}/three.txt`, 'not selected'); put(`${d}/f/inner.txt`, 'inner');
    const { res, entries } = await download(`${d}/one.txt`, `${d}/two.txt`, `${d}/f`, `${d}/f/inner.txt`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain(`filename="${d.slice(1)}.zip"`);
    expect(entries.map((e) => e.name).sort()).toEqual(['f/', 'f/inner.txt', 'one.txt', 'two.txt']);
    expect(entries.find((e) => e.name === 'f/inner.txt')!.data.toString()).toBe('inner');
  });

  it('the whole home has names without a leading slash and is called files.zip', async () => {
    const d = fresh('rootdl');
    put(`${d}/x.txt`, 'x');
    const { res, entries } = await download('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('filename="files.zip"');
    expect(entries.map((e) => e.name)).toContain(`${d.slice(1)}/x.txt`);
    for (const e of entries) expect(e.name.startsWith('/') || e.name.split('/').includes('..'), e.name).toBe(false);
  });

  it('leaves out symlinks, the internal .files/ area and upload temp files; nothing outside the home leaks', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'files-zip-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    const d = fresh('filtered');
    put(`${d}/keep.txt`, 'keep');
    put(`${d}/gone.txt`, 'to the trash');
    symlinkSync(join(outside, 'secret.txt'), join(root, d, 'link.txt'));
    symlinkSync(outside, join(root, d, 'linkdir'));
    put(`${d}/.0123456789abcdef.upload`, 'half an upload');
    const del = await t.app.inject({ method: 'POST', url: '/api/v1/sources/home/delete',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN }, payload: { paths: [`${d}/gone.txt`] } });
    expect(del.statusCode).toBe(204);
    expect(readdirSync(join(root, '.files', 'trash')).length).toBeGreaterThan(0);

    for (const target of ['/', d]) {
      const { res, entries } = await download(target);
      expect(res.statusCode, target).toBe(200);
      const names = entries.map((e) => e.name);
      const prefix = target === '/' ? `${d.slice(1)}/` : `${d.slice(1)}/`;
      expect(names, target).toContain(`${prefix}keep.txt`);
      expect(names.filter((x) => x.startsWith('.files') || x.includes('/.files/')), target).toEqual([]);
      expect(names.filter((x) => /link|\.upload$|gone/.test(x)), target).toEqual([]);
      for (const e of entries) expect(e.data.includes('SECRET'), e.name).toBe(false);
      for (const e of entries) expect(e.data.includes('to the trash'), e.name).toBe(false);
    }
    rmSync(outside, { recursive: true, force: true });
  });

  it('refuses a symlink or the internal area as a selected path, and answers errors before streaming', async () => {
    const d = fresh('refused');
    symlinkSync(tmpdir(), join(root, d, 'link'));
    put(`${d}/a.txt`, 'a'); put(`${d}/sub/b.txt`, 'b');
    const cases: [string[], number, string][] = [
      [[`${d}/link`], 400, 'PATH_SYMLINK'],
      [['/.files'], 400, 'PATH_INVALID'],
      [['/.files/trash'], 400, 'PATH_INVALID'],
      [[`${d}/missing`], 404, 'NOT_FOUND'],
      [[`${d}/a.txt`, `${d}/sub/b.txt`], 400, 'VALIDATION'], // not one folder
      [[`${d}/../x`], 400, 'PATH_INVALID'],
    ];
    for (const [paths, status, code] of cases) {
      const r = await t.app.inject({ url: zipUrl(...paths), headers: { cookie: a.cookie } });
      expect(r.statusCode, paths.join(',')).toBe(status);
      expect(r.json().code, paths.join(',')).toBe(code);
    }
    const none = await t.app.inject({ url: '/api/v1/sources/home/zip', headers: { cookie: a.cookie } });
    expect(none.statusCode).toBe(400);
    const anon = await t.app.inject({ url: zipUrl(d) });
    expect(anon.statusCode).toBe(401);
    const other = await t.app.inject({ url: zipUrl(d).replace('/home/', '/home:x/'), headers: { cookie: a.cookie } });
    expect(other.statusCode).toBe(404);
  });

  it('a 1 GiB sparse file streams as a valid ZIP64 with bounded memory', async () => {
    const GiB = 2 ** 30;
    const d = fresh('big');
    writeFileSync(join(root, d, 'huge.bin'), '');
    truncateSync(join(root, d, 'huge.bin'), GiB);
    // CRC of 1 GiB of zeros, computed independently.
    const zeros = Buffer.alloc(1 << 20);
    let expected = 0;
    for (let i = 0; i < 1024; i++) expected = crc32(zeros, expected);

    global.gc?.();
    const base = process.memoryUsage.rss();
    let peak = base;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 20);
    const res = await get(zipUrl(`${d}/huge.bin`));
    expect(res.statusCode).toBe(200);
    // Streamed: the head is checked as it arrives; only the data CRC and the last bytes are kept.
    let total = 0; let head = Buffer.alloc(0); let dataStart = -1; let crc = 0; let tail = Buffer.alloc(0);
    for await (const chunk of res as AsyncIterable<Buffer>) {
      if (dataStart < 0) {
        head = Buffer.concat([head, chunk]);
        if (head.length >= 30) {
          const nameLen = head.readUInt16LE(26); const extraLen = head.readUInt16LE(28);
          dataStart = 30 + nameLen + extraLen;
        }
      }
      if (dataStart >= 0) {
        const from = Math.max(dataStart, total); const to = Math.min(dataStart + GiB, total + chunk.length);
        if (to > from) crc = crc32(chunk.subarray(from - total, to - total), crc);
      }
      total += chunk.length;
      tail = Buffer.concat([tail, chunk]).subarray(-65536);
    }
    clearInterval(sampler);
    expect(peak - base).toBeLessThan(200 * 1024 * 1024);
    expect(crc).toBe(expected);

    // Local header: stored, data descriptor + UTF-8, ZIP64 sizes.
    expect(head.readUInt32LE(0)).toBe(0x04034b50);
    expect(head.readUInt16LE(4)).toBe(45);
    expect(head.readUInt16LE(6) & 0x0808).toBe(0x0808);
    expect(head.readUInt16LE(8)).toBe(0);
    expect(head.readUInt32LE(22)).toBe(0xffffffff);
    expect(head.subarray(30, 30 + head.readUInt16LE(26)).toString()).toBe('huge.bin');
    expect(head.readUInt16LE(30 + 8)).toBe(0x0001);
    // Data descriptor right after the data, with 8-byte sizes.
    const at = (abs: number) => tail.length - (total - abs);
    const dd = at(dataStart + GiB);
    expect(tail.readUInt32LE(dd)).toBe(0x08074b50);
    expect(tail.readUInt32LE(dd + 4)).toBe(expected);
    expect(Number(tail.readBigUInt64LE(dd + 8))).toBe(GiB);
    expect(Number(tail.readBigUInt64LE(dd + 16))).toBe(GiB);
    // End records: EOCD -> ZIP64 locator -> ZIP64 EOCD -> central directory.
    const eocd = tail.length - 22;
    expect(tail.readUInt32LE(eocd)).toBe(0x06054b50);
    const loc = eocd - 20;
    expect(tail.readUInt32LE(loc)).toBe(0x07064b50);
    const z64 = at(Number(tail.readBigUInt64LE(loc + 8)));
    expect(tail.readUInt32LE(z64)).toBe(0x06064b50);
    expect(Number(tail.readBigUInt64LE(z64 + 32))).toBe(1);
    const cd = at(Number(tail.readBigUInt64LE(z64 + 48)));
    expect(cd).toBe(dd + 24);
    expect(tail.readUInt32LE(cd)).toBe(0x02014b50);
    expect(tail.readUInt32LE(cd + 16)).toBe(expected);
    expect(tail.readUInt32LE(cd + 24)).toBe(0xffffffff);
    const extra = cd + 46 + tail.readUInt16LE(cd + 28);
    expect(tail.readUInt16LE(extra)).toBe(0x0001);
    expect(Number(tail.readBigUInt64LE(extra + 4))).toBe(GiB);
    expect(Number(tail.readBigUInt64LE(extra + 12))).toBe(GiB);
  }, 120_000);

  it('a client disconnect mid-stream closes the source file and leaves no temp files', async () => {
    const d = fresh('cut');
    const huge = join(root, d, 'huge.bin');
    writeFileSync(huge, '');
    truncateSync(huge, 2 ** 30);
    // Every name under the data dir, without following symlinks (other tests leave some behind).
    const tree = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? [join(dir, e.name), ...tree(join(dir, e.name))] : [join(dir, e.name)]);
    const before = tree(t.dataDir);
    const openOnHuge = () => readdirSync('/proc/self/fd').filter((fd) => {
      try { return readlinkSync(`/proc/self/fd/${fd}`) === huge; }
      catch { return false; } // handled: the fd closed between readdir and readlink
    }).length;

    const res = await get(zipUrl(d));
    expect(res.statusCode).toBe(200);
    await new Promise<void>((resolve) => res.once('data', () => resolve()));
    res.pause();
    await new Promise((r) => setTimeout(r, 200));
    expect(openOnHuge()).toBe(1); // reading is under way, held back by the paused client
    res.destroy();
    const deadline = Date.now() + 5000;
    while (openOnHuge() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(openOnHuge()).toBe(0);
    expect(tree(t.dataDir).filter((p) => !before.includes(p)).map((p) => relative(t.dataDir, p))).toEqual([]);
  });
});

// zipStream over a stub backend: what a listing hands it is checked once more, and a failed read ends the stream
// with the error instead of a short but well-formed archive.
describe('zipStream', () => {
  const at = '2026-10-15T10:00:00.000Z';
  const file = (name: string): Entry => ({ name, path: `/d/${name}`, type: 'file', size: 1, modified: at, mime: 'text/plain' });
  const dir: Entry = { name: 'd', path: '/d', type: 'directory', size: 0, modified: at };
  const stub = (children: Entry[], read: (p: string) => Readable) => ({
    list: async () => ({ entries: children }),
    read: async (p: string) => ({ entry: children.find((c) => c.path === p)!, stream: read(p), etag: '"x"' }),
  }) as unknown as StorageBackend;
  const collect = async (b: StorageBackend, seen: Buffer[] = []) => {
    for await (const c of zipStream(b, [{ name: 'd', entry: dir }])) seen.push(c);
    return seen;
  };

  it.each(['..', '.', 'a\\b', ''])('refuses an entry named %j from a listing', async (name) => {
    await expect(collect(stub([file(name)], () => Readable.from([Buffer.from('x')])))).rejects.toMatchObject({ code: 'PATH_INVALID' });
  });

  it('a read that fails after the first bytes rejects the stream; no end record is written', async () => {
    const b = stub([file('a.txt'), file('b.txt')], (p) => {
      if (p === '/d/b.txt') throw new AppError('NOT_FOUND');
      return Readable.from([Buffer.from('a')]);
    });
    const seen: Buffer[] = [];
    await expect(collect(b, seen)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((c) => c.length >= 4 && c.readUInt32LE(0) === 0x06054b50)).toBe(false);
  });
});
