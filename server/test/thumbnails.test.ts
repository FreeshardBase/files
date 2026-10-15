import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { homeRoot, thumbsDir } from '../src/paths.ts';
import { THUMB_CONCURRENCY } from '../src/storage/thumbnails.ts';

// #144: local thumbnails. Spies on the two ways a thumbnail is generated (an external tool through `spawn`, an image
// through `sharp(file)`), so the tests see whether a request generated or was served from the cache, and with which
// arguments a tool ran.
vi.mock('node:child_process', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:child_process')>();
  return { ...m, spawn: vi.fn(m.spawn) };
});
vi.mock('sharp', async (importOriginal) => {
  const m = await importOriginal<{ default: typeof sharp }>();
  const spy = vi.fn((...args: Parameters<typeof m.default>) => m.default(...args));
  return { default: Object.assign(spy, m.default) };
});
const spawnSpy = vi.mocked(spawn);
const realSpawn = spawnSpy.getMockImplementation()!;
const sharpSpy = vi.mocked(sharp);

const ORIGIN = 'https://files.example.com';
type Auth = { cookie: string; csrf: string };

// ---- fixtures, made here so the repo holds no binaries --------------------------------------------------------------
const jpeg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3,
  background: { r: 0, g: 112, b: 128 }, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).jpeg().toBuffer();

const fixtureDir = mkdtempSync(join(tmpdir(), 'files-thumb-fixtures-'));
let mp4Seq = 0;
/** A two-second 640×360 H.264 test pattern, made by the same ffmpeg the server uses. */
function mp4(): Buffer {
  const out = join(fixtureDir, `clip-${++mp4Seq}.mp4`);
  const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    `testsrc=size=640x360:rate=25:duration=2,hue=h=${mp4Seq * 40}`, '-pix_fmt', 'yuv420p', out]);
  if (r.status !== 0) throw new Error(`ffmpeg fixture failed: ${r.stderr}`);
  return readFileSync(out);
}
/** A one-page 600×800 pt PDF with a blue square. */
function pdf(): Buffer {
  const content = '0 0 1 rg 50 50 500 700 re f';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let out = '%PDF-1.4\n'; const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

// ---- helpers ---------------------------------------------------------------------------------------------------------
async function put(t: TestApp, a: Auth, path: string, body: Buffer, onCollision = 'fail') {
  const r = await t.app.inject({
    method: 'PUT', url: `/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=${onCollision}`,
    headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN, 'content-type': 'application/octet-stream' }, payload: body,
  });
  expect(r.statusCode, r.body).toBe(201);
}
const post = (t: TestApp, a: Auth, op: string, body: object) => t.app.inject({ method: 'POST', url: `/api/v1/sources/home/${op}`,
  headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN }, payload: body });
const thumb = (t: TestApp, a: Auth, path: string, size: number | string = 256) =>
  t.app.inject({ url: `/api/v1/sources/home/thumbnail?path=${encodeURIComponent(path)}&size=${size}`, headers: { cookie: a.cookie } });

/** Generator runs so far: tool processes plus `sharp` opened on a file of the data dir. */
const generated = (t: TestApp) => spawnSpy.mock.calls.length
  + sharpSpy.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].startsWith(t.dataDir)).length;
const homeOf = (t: TestApp, sub = 'testuser') => homeRoot(t.dataDir, t.db.prepare('SELECT id FROM users WHERE sub = ?').pluck().get(sub) as string);
const cacheFiles = (t: TestApp) => readdirSync(thumbsDir(t.dataDir));
const cacheBytes = (t: TestApp) => cacheFiles(t).reduce((n, f) => n + statSync(join(thumbsDir(t.dataDir), f)).size, 0);

async function expectThumb(r: { statusCode: number; body: string; headers: Record<string, unknown>; rawPayload: Buffer }, size: number) {
  expect(r.statusCode, r.body).toBe(200);
  expect(r.headers['content-type']).toBe('image/webp');
  const meta = await sharp(r.rawPayload).metadata();
  expect(meta.format).toBe('webp');
  expect(Math.max(meta.width, meta.height)).toBe(size);
  return meta;
}

beforeEach(() => { spawnSpy.mockClear(); sharpSpy.mockClear(); spawnSpy.mockImplementation(realSpawn); });

describe('thumbnails of images, videos and PDFs', () => {
  let t: TestApp; let a: Auth;
  beforeAll(async () => { t = await startTestApp(); a = await login(t); });
  afterAll(() => t.close());

  it.each([
    ['photo.jpg', () => jpeg(800, 600), 4 / 3],
    ['clip.mp4', async () => mp4(), 16 / 9],
    ['doc.pdf', async () => pdf(), 3 / 4],
  ])('%s gives a WebP of the requested size; the second request comes from the cache', async (name, make, aspect) => {
    const path = `/kinds/${name}`;
    await put(t, a, path, await make());
    for (const size of [128, 256, 512]) {
      const before = generated(t);
      const first = await thumb(t, a, path, size);
      const meta = await expectThumb(first, size);
      expect(meta.width / meta.height).toBeCloseTo(aspect, 1);
      expect(generated(t)).toBe(before + 1);
      const second = await thumb(t, a, path, size);
      await expectThumb(second, size);
      expect(second.rawPayload.equals(first.rawPayload)).toBe(true);
      expect(generated(t)).toBe(before + 1); // served from the cache, no generator ran
    }
  });

  it('answers typed errors for what has no thumbnail', async () => {
    await put(t, a, '/kinds/notes.txt', Buffer.from('hello'));
    await put(t, a, '/kinds/vector.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect((await thumb(t, a, '/kinds/notes.txt')).json()).toEqual({ code: 'NO_THUMBNAIL' });
    expect((await thumb(t, a, '/kinds/vector.svg')).json()).toEqual({ code: 'NO_THUMBNAIL' });
    expect((await thumb(t, a, '/kinds')).json()).toEqual({ code: 'IS_A_DIRECTORY' });
    expect((await thumb(t, a, '/kinds/missing.jpg')).statusCode).toBe(404);
    expect((await thumb(t, a, '/.files/trash')).json()).toEqual({ code: 'PATH_INVALID' });
    expect((await thumb(t, a, '/kinds/../etc/passwd')).json()).toEqual({ code: 'PATH_INVALID' });
    for (const size of ['300', '0', 'big', '']) expect((await thumb(t, a, '/kinds/notes.txt', size)).json()).toEqual({ code: 'VALIDATION' });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('thumbnails files named like options; the name never becomes a process option (tar injection class)', async () => {
    const files: [string, Buffer][] = [['-vf.jpg', await jpeg(800, 600)], ['--help.mp4', mp4()], ['-h.pdf', pdf()], ['-vf.pdf', pdf()]];
    for (const [name, body] of files) {
      await put(t, a, `/inject/${name}`, body);
      await expectThumb(await thumb(t, a, `/inject/${name}`), 256);
    }
    const home = homeOf(t);
    // The image is opened by the library on its absolute path, never handed to a process.
    expect(sharpSpy.mock.calls.filter((c) => typeof c[0] === 'string').map((c) => c[0])).toEqual([join(home, 'inject', '-vf.jpg')]);
    const calls = spawnSpy.mock.calls.map(([cmd, args, opts]) => ({ cmd, args: [...(args ?? [])], opts }));
    expect(calls.map((c) => c.cmd)).toEqual(['ffmpeg', 'pdftoppm', 'pdftoppm']);
    for (const { cmd, args, opts } of calls) {
      expect((opts as { shell?: unknown } | undefined)?.shell ?? false).toBe(false);
      const abs = join(home, 'inject', cmd === 'ffmpeg' ? '--help.mp4' : args.at(-1)!.endsWith('-h.pdf') ? '-h.pdf' : '-vf.pdf');
      // The file appears exactly once, as an absolute path that cannot be read as an option ...
      const at = args.flatMap((x, i) => (x.includes(abs.slice(abs.lastIndexOf('/') + 1)) ? [i] : []));
      expect(at).toHaveLength(1);
      if (cmd === 'ffmpeg') {
        // ... as the value of -i, through the file protocol only, with the demuxer fixed by the extension.
        expect(args[at[0]!]).toBe(`file:${abs}`);
        expect(args[at[0]! - 1]).toBe('-i');
        expect(args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 2)).toEqual(['-protocol_whitelist', 'file']);
        expect(args[args.indexOf('-i') - 2]).toBe('-f');
      } else {
        // ... and after `--`, so even a relative name could not be parsed as an option.
        expect(args[at[0]!]).toBe(abs);
        expect(args[at[0]! - 1]).toBe('--');
        expect(at[0]).toBe(args.length - 1);
      }
      // No option the code did not put there: every argument before the file is one of the fixed ones.
      for (const x of args.slice(0, at[0])) expect(x.includes('inject')).toBe(false);
    }
  });

  it('a corrupt image, video or PDF answers a typed error, and the server keeps serving', async () => {
    for (const name of ['bad.jpg', 'bad.png', 'bad.mp4', 'bad.pdf']) {
      await put(t, a, `/corrupt/${name}`, Buffer.from('this is not what the extension says '.repeat(20)));
      const r = await thumb(t, a, `/corrupt/${name}`);
      expect(r.statusCode, name).toBe(422);
      expect(r.json()).toEqual({ code: 'THUMBNAIL_FAILED' });
    }
    expect((await t.app.inject('/healthz')).statusCode).toBe(200);
    await put(t, a, '/corrupt/good.jpg', await jpeg(400, 400));
    await expectThumb(await thumb(t, a, '/corrupt/good.jpg', 128), 128);
    expect(cacheFiles(t).filter((f) => !f.endsWith('.webp'))).toEqual([]); // no temp file left by the failures
  });

  it('runs at most THUMB_CONCURRENCY generators at once', async () => {
    let active = 0; let peak = 0;
    spawnSpy.mockImplementation(((...args: Parameters<typeof spawn>) => {
      const child = (realSpawn as (...a: Parameters<typeof spawn>) => ChildProcess)(...args);
      active++; peak = Math.max(peak, active);
      child.on('close', () => { active--; });
      return child;
    }) as typeof spawn);
    const names = Array.from({ length: 6 }, (_, i) => `/parallel/c${i}.mp4`);
    for (const n of names) await put(t, a, n, mp4());
    const results = await Promise.all(names.map((n) => thumb(t, a, n, 128)));
    for (const r of results) await expectThumb(r, 128);
    expect(spawnSpy).toHaveBeenCalledTimes(6);
    expect(peak).toBeGreaterThanOrEqual(1);
    expect(peak).toBeLessThanOrEqual(THUMB_CONCURRENCY);
    expect(THUMB_CONCURRENCY).toBeLessThan(6);
  });
});

describe('the cache', () => {
  const CAP = 60_000;
  let t: TestApp; let a: Auth;
  beforeAll(async () => { t = await startTestApp({ FILES_THUMB_CACHE_BYTES: String(CAP) }); a = await login(t); });
  afterAll(() => t.close());

  it('stays under its cap after many requests and evicts the least recently used', async () => {
    await put(t, a, '/many/keep.jpg', await jpeg(900, 600));
    await expectThumb(await thumb(t, a, '/many/keep.jpg'), 256);
    for (let i = 0; i < 14; i++) {
      await put(t, a, `/many/p${i}.jpg`, await jpeg(900, 600));
      await expectThumb(await thumb(t, a, `/many/p${i}.jpg`), 256);
      expect(cacheBytes(t)).toBeLessThanOrEqual(CAP);
      // `keep` is used between every two others, so it is never the least recently used one.
      const before = generated(t);
      await expectThumb(await thumb(t, a, '/many/keep.jpg'), 256);
      expect(generated(t)).toBe(before);
    }
    const files = cacheFiles(t);
    expect(files.length).toBeGreaterThan(1);
    expect(files.length).toBeLessThan(15); // something was evicted ...
    const before = generated(t);
    await expectThumb(await thumb(t, a, '/many/p0.jpg'), 256); // ... the oldest one, which is generated again
    expect(generated(t)).toBe(before + 1);
    expect(cacheBytes(t)).toBeLessThanOrEqual(CAP);
  });
});

describe('invalidation', () => {
  let t: TestApp; let a: Auth;
  beforeAll(async () => { t = await startTestApp(); a = await login(t); });
  afterAll(() => t.close());

  it('a renamed, moved or deleted file loses its thumbnail; a replaced file gets a new one', async () => {
    await put(t, a, '/inv/a.jpg', await jpeg(800, 600));
    await expectThumb(await thumb(t, a, '/inv/a.jpg', 128), 128);
    await expectThumb(await thumb(t, a, '/inv/a.jpg', 256), 256);
    expect(cacheFiles(t)).toHaveLength(2);
    expect((await post(t, a, 'move', { from: '/inv/a.jpg', to: '/inv/b.jpg', onCollision: 'fail' })).statusCode).toBe(200);
    expect(cacheFiles(t)).toEqual([]);

    await expectThumb(await thumb(t, a, '/inv/b.jpg'), 256);
    expect(cacheFiles(t)).toHaveLength(1);
    expect((await post(t, a, 'delete', { paths: ['/inv/b.jpg'] })).statusCode).toBe(204);
    expect(cacheFiles(t)).toEqual([]);

    // A folder move takes the thumbnails of everything inside with it.
    await put(t, a, '/inv/dir/sub/c.jpg', await jpeg(800, 600));
    await expectThumb(await thumb(t, a, '/inv/dir/sub/c.jpg'), 256);
    expect((await post(t, a, 'move', { from: '/inv/dir', to: '/inv/dir2', onCollision: 'fail' })).statusCode).toBe(200);
    expect(cacheFiles(t)).toEqual([]);

    await put(t, a, '/inv/d.jpg', await jpeg(800, 600));
    expect((await expectThumb(await thumb(t, a, '/inv/d.jpg'), 256)).width).toBe(256);
    await put(t, a, '/inv/d.jpg', await jpeg(300, 600), 'replace');
    expect(cacheFiles(t)).toEqual([]);
    expect((await expectThumb(await thumb(t, a, '/inv/d.jpg'), 256)).width).toBe(128);
  });
});

describe('timeouts', () => {
  let t: TestApp; let a: Auth;
  beforeAll(async () => { t = await startTestApp({ FILES_THUMB_TIMEOUT_MS: '1' }); a = await login(t); });
  afterAll(() => t.close());

  it('kills a generator that exceeds its timeout and answers a typed error', async () => {
    await put(t, a, '/slow/clip.mp4', mp4());
    const r = await thumb(t, a, '/slow/clip.mp4');
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ code: 'THUMBNAIL_FAILED' });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const child = spawnSpy.mock.results[0]!.value as ChildProcess;
    expect(child.signalCode).toBe('SIGKILL');
    expect(cacheFiles(t)).toEqual([]);
  });
});
