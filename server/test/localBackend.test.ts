import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';
import { LocalBackend, homeRoot, mapFsError } from '../src/storage/local.ts';

let root: string; let b: LocalBackend;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'files-lb-')); b = new LocalBackend(root); });
const body = (s: string) => Readable.from([Buffer.from(s)]);
const err = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as { code: string }).code; } };
const opts = { onCollision: 'fail' as const, maxBytes: 1024 * 1024 };

describe('write + read', () => {
  it('round-trips a file with an awkward name', async () => {
    const name = '/Prüfung #1 50% 🎉.txt';
    const e = await b.write(name, body('hello'), opts);
    expect(e.name).toBe('Prüfung #1 50% 🎉.txt');
    const r = await b.read(e.path);
    expect(await text(r.stream)).toBe('hello');
    expect(r.size).toBe(5);
  });
  it('reads a byte range', async () => {
    await b.write('/r.txt', body('0123456789'), opts);
    const r = await b.read('/r.txt', { start: 2, end: 5 });
    expect(await text(r.stream)).toBe('2345');
  });
  it('fails with FILE_EXISTS and leaves the original untouched', async () => {
    await b.write('/a.txt', body('one'), opts);
    expect(await err(b.write('/a.txt', body('two'), opts))).toBe('FILE_EXISTS');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one');
  });
  it('replace overwrites atomically', async () => {
    await b.write('/a.txt', body('one'), opts);
    await b.write('/a.txt', body('two'), { ...opts, onCollision: 'replace' });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('two');
  });
  it('keep-both picks a free name', async () => {
    await b.write('/a.txt', body('one'), opts);
    const e = await b.write('/a.txt', body('two'), { ...opts, onCollision: 'keep-both' });
    expect(e.name).toBe('a (2).txt');
  });
  it('two concurrent fail-uploads: exactly one wins, content is never mixed', async () => {
    const results = await Promise.allSettled([
      b.write('/c.txt', body('A'.repeat(100000)), opts),
      b.write('/c.txt', body('B'.repeat(100000)), opts),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const content = readFileSync(join(root, 'c.txt'), 'utf8');
    expect(content === 'A'.repeat(100000) || content === 'B'.repeat(100000)).toBe(true);
  });
  it('an aborted upload leaves neither target nor temp file', async () => {
    const s = new PassThrough();
    s.on('error', () => undefined); // handled: destroyed before write() attaches; write() must still reject
    const p = b.write('/broken.bin', s, opts);
    s.write(Buffer.alloc(1000));
    s.destroy(new Error('client went away'));
    await expect(p).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]);
  });
  it('rejects a body larger than maxBytes and cleans up', async () => {
    expect(await err(b.write('/big.bin', body('x'.repeat(2000)), { ...opts, maxBytes: 1000 }))).toBe('PAYLOAD_TOO_LARGE');
    expect(readdirSync(root)).toEqual([]);
  });
  it('refuses to write through a directory path', async () => {
    mkdirSync(join(root, 'd'));
    expect(await err(b.write('/d', body('x'), opts))).toBe('IS_A_DIRECTORY');
  });
});

describe('list', () => {
  it('paginates 1200 entries, every entry exactly once, folders first then by name', async () => {
    mkdirSync(join(root, 'big'));
    for (let i = 0; i < 1200; i++) writeFileSync(join(root, 'big', `f${String(i).padStart(4, '0')}.txt`), '');
    mkdirSync(join(root, 'big', 'zz-folder'));
    const seen: string[] = []; let cursor: string | undefined;
    do {
      const page = await b.list('/big', cursor, 500);
      seen.push(...page.entries.map((e) => e.name));
      cursor = page.next;
    } while (cursor);
    expect(seen).toHaveLength(1201);
    expect(new Set(seen).size).toBe(1201);
    expect(seen[0]).toBe('zz-folder');
  });
  it('hides the internal .files directory', async () => {
    mkdirSync(join(root, '.files'));
    expect((await b.list('/')).entries).toEqual([]);
  });
  it('returns NOT_FOUND and NOT_A_DIRECTORY correctly', async () => {
    await b.write('/f.txt', body('x'), opts);
    expect(await err(b.list('/nope'))).toBe('NOT_FOUND');
    expect(await err(b.list('/f.txt'))).toBe('NOT_A_DIRECTORY');
  });
});

describe('mkdir', () => {
  it('creates nested folders and refuses an existing one', async () => {
    const e = await b.mkdir('/a/b');
    expect(e.type).toBe('directory');
    expect(await err(b.mkdir('/a/b'))).toBe('FILE_EXISTS');
  });
});

describe('internal .files area', () => {
  it.each(['/.files', '/.files/x', '/.files/trash/y', '//.files//x'])('rejects every operation on %s with PATH_INVALID', async (p) => {
    mkdirSync(join(root, '.files', 'trash'), { recursive: true });
    writeFileSync(join(root, '.files', 'x'), 'secret');
    expect(await err(b.read(p))).toBe('PATH_INVALID');
    expect(await err(b.stat(p))).toBe('PATH_INVALID');
    expect(await err(b.list(p))).toBe('PATH_INVALID');
    expect(await err(b.mkdir(p))).toBe('PATH_INVALID');
    expect(await err(b.write(p, body('x'), { ...opts, onCollision: 'replace' }))).toBe('PATH_INVALID');
    expect(readFileSync(join(root, '.files', 'x'), 'utf8')).toBe('secret');
  });
  it('still allows names that merely start with .files', async () => {
    const e = await b.write('/.filesystem.txt', body('x'), opts);
    expect(e.name).toBe('.filesystem.txt');
  });
});

describe('homeRoot', () => {
  it('is DATA_DIR/homes/<userId>', () => {
    expect(homeRoot('/data', 'u1')).toBe('/data/homes/u1');
  });
});

describe('robust listing', () => {
  it('skips unaddressable on-disk names and still lists the rest', async () => {
    writeFileSync(join(root, 'bad\nname'), '');
    writeFileSync(join(root, 'a\\b'), '');
    writeFileSync(join(root, 'Pru\u0308fung.txt'), '');
    writeFileSync(Buffer.concat([Buffer.from(root + '/'), Buffer.from([0x69, 0x6e, 0x76, 0xff, 0x2e, 0x74, 0x78, 0x74])]), '');
    writeFileSync(join(root, 'good.txt'), '');
    expect((await b.list('/')).entries.map((e) => e.name)).toEqual(['good.txt']);
  });
});

describe('temp files are hidden', () => {
  it('hides and refuses the temp file of a pending upload', async () => {
    const s = new PassThrough();
    const p = b.write('/pending.bin', s, opts);
    s.write(Buffer.alloc(100));
    let tmpName: string | undefined;
    for (let i = 0; i < 100 && !tmpName; i++) {
      tmpName = readdirSync(root).find((n) => /^\.[0-9a-f]{16}\.upload$/.test(n));
      if (!tmpName) await new Promise((r) => setTimeout(r, 10));
    }
    expect(tmpName).toBeDefined();
    expect((await b.list('/')).entries).toEqual([]);
    expect(await err(b.read('/' + tmpName))).toBe('PATH_INVALID');
    expect(await err(b.stat('/' + tmpName))).toBe('PATH_INVALID');
    s.end();
    await p;
  });
});

describe('mkdir race', () => {
  it('two concurrent mkdirs: exactly one succeeds', async () => {
    const r = await Promise.allSettled([b.mkdir('/d'), b.mkdir('/d')]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rej = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect((rej.reason as { code: string }).code).toBe('FILE_EXISTS');
  });
});

describe('keep-both on a long name', () => {
  it('shortens the stem so the numbered name fits in 255 bytes', async () => {
    const name = 'é'.repeat(125) + '.txt';
    expect(Buffer.byteLength(name)).toBe(254);
    await b.write('/' + name, body('one'), opts);
    const e = await b.write('/' + name, body('two'), { ...opts, onCollision: 'keep-both' });
    expect(Buffer.byteLength(e.name)).toBeLessThanOrEqual(255);
    expect(e.name.endsWith(' (2).txt')).toBe(true);
    expect(e.name.isWellFormed()).toBe(true);
  });
});

describe('special files', () => {
  it('treats a FIFO as not found for stat and read', async () => {
    try { execFileSync('mkfifo', [join(root, 'p')]); } catch { return; } // handled: mkfifo unavailable, skip
    expect(await err(b.stat('/p'))).toBe('NOT_FOUND');
    expect(await err(b.read('/p'))).toBe('NOT_FOUND');
  });
});

describe('mapFsError', () => {
  const e = (code: string) => Object.assign(new Error(code), { code });
  it.each([['ENOSPC', 'STORAGE_FULL'], ['EDQUOT', 'STORAGE_FULL'], ['ENAMETOOLONG', 'PATH_INVALID']])('%s -> %s', (c, out) => {
    expect((mapFsError(e(c)) as { code: string }).code).toBe(out);
  });
  it('passes other errors through unchanged', () => {
    const x = e('EIO');
    expect(mapFsError(x)).toBe(x);
  });
});

describe('keyset cursor', () => {
  it('survives deletion of an earlier entry between pages', async () => {
    for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) writeFileSync(join(root, n), '');
    const p1 = await b.list('/', undefined, 3);
    expect(p1.entries.map((x) => x.name)).toEqual(['a', 'b', 'c']);
    rmSync(join(root, 'a'));
    const p2 = await b.list('/', p1.next, 3);
    expect(p2.entries.map((x) => x.name)).toEqual(['d', 'e', 'f']);
    expect(p2.next).toBeUndefined();
  });
  it('orders folders first across the cursor boundary', async () => {
    mkdirSync(join(root, 'z-dir')); writeFileSync(join(root, 'a'), '');
    const p1 = await b.list('/', undefined, 1);
    expect(p1.entries[0]!.name).toBe('z-dir');
    expect((await b.list('/', p1.next, 1)).entries[0]!.name).toBe('a');
  });
  it.each([0, 1001, 1.5, -1, Number.NaN])('rejects limit %s', async (l) => {
    expect(await err(b.list('/', undefined, l))).toBe('VALIDATION');
  });
  it('rejects a garbage cursor', async () => {
    expect(await err(b.list('/', 'not-a-cursor'))).toBe('VALIDATION');
    expect(await err(b.list('/', Buffer.from('{"d":2,"n":5}').toString('base64url')))).toBe('VALIDATION');
  });
});

describe('etag', () => {
  it('changes when a file is replaced', async () => {
    await b.write('/e.txt', body('same'), opts);
    const first = (await b.read('/e.txt')).etag;
    await b.write('/e.txt', body('same'), { ...opts, onCollision: 'replace' });
    expect((await b.read('/e.txt')).etag).not.toBe(first);
  });
});
