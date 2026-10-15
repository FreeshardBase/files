import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync, mkdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';
import { LocalBackend, mapFsError } from '../src/storage/local.ts';
import { resolveInRoot } from '../src/storage/resolveInRoot.ts';
import { testIndex } from './support/homeIndex.ts';

let root: string; let b: LocalBackend;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'files-lb-')); b = new LocalBackend(root, testIndex()); });
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
    expect(r.entry).toMatchObject({ name: 'Prüfung #1 50% 🎉.txt', path: name, type: 'file', size: 5, mime: 'text/plain' });
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
    expect(e.name).toBe('a (1).txt');
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
  it('ifMatch with the current ETag replaces the file', async () => {
    await b.write('/m.txt', body('one'), opts);
    const { etag, stream } = await b.read('/m.txt'); stream.destroy();
    await b.write('/m.txt', body('two'), { ...opts, onCollision: 'replace', ifMatch: etag });
    expect(readFileSync(join(root, 'm.txt'), 'utf8')).toBe('two');
  });
  it('ifMatch with a stale ETag fails with PRECONDITION_FAILED and leaves the file and no temp file', async () => {
    await b.write('/m.txt', body('one'), opts);
    const { etag: stale, stream } = await b.read('/m.txt'); stream.destroy();
    await b.write('/m.txt', body('changed'), { ...opts, onCollision: 'replace' });
    expect(await err(b.write('/m.txt', body('lost update'), { ...opts, onCollision: 'replace', ifMatch: stale }))).toBe('PRECONDITION_FAILED');
    expect(readFileSync(join(root, 'm.txt'), 'utf8')).toBe('changed');
    // `.files` holds the version the first replace kept (#154); the refused write added nothing.
    expect(readdirSync(root).sort()).toEqual(['.files', 'm.txt']);
    expect(readdirSync(join(root, '.files', 'versions'))).toHaveLength(1);
  });
  it('ifMatch on a missing file fails with PRECONDITION_FAILED and creates nothing', async () => {
    expect(await err(b.write('/gone.txt', body('x'), { ...opts, onCollision: 'replace', ifMatch: '"1-1-1"' }))).toBe('PRECONDITION_FAILED');
    expect(readdirSync(root)).toEqual([]);
  });
  it('ifMatch is only valid with onCollision replace', async () => {
    await b.write('/m.txt', body('one'), opts);
    const { etag, stream } = await b.read('/m.txt'); stream.destroy();
    expect(await err(b.write('/m.txt', body('two'), { ...opts, ifMatch: etag }))).toBe('VALIDATION');
    expect(readFileSync(join(root, 'm.txt'), 'utf8')).toBe('one');
  });
  it.each([['fewer', 'abc', 5], ['more', 'abcdefgh', 5]])('a size that disagrees with %s streamed bytes fails with SIZE_MISMATCH and leaves no file', async (_l, data, size) => {
    expect(await err(b.write('/s.txt', body(data), { ...opts, size }))).toBe('SIZE_MISMATCH');
    expect(readdirSync(root)).toEqual([]);
  });
  it('a size mismatch on replace leaves the existing file unchanged', async () => {
    await b.write('/s.txt', body('keep'), opts);
    expect(await err(b.write('/s.txt', body('abc'), { ...opts, onCollision: 'replace', size: 4 }))).toBe('SIZE_MISMATCH');
    expect(readFileSync(join(root, 's.txt'), 'utf8')).toBe('keep');
    expect(readdirSync(root)).toEqual(['s.txt']);
  });
  it('a matching size is accepted', async () => {
    expect((await b.write('/s.txt', body('abcde'), { ...opts, size: 5 })).size).toBe(5);
  });
  it('a declared size above maxBytes is rejected before the body is read', async () => {
    expect(await err(b.write('/s.txt', new PassThrough(), { ...opts, maxBytes: 10, size: 11 }))).toBe('PAYLOAD_TOO_LARGE');
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
    expect(e.name.endsWith(' (1).txt')).toBe(true);
    expect(e.name.isWellFormed()).toBe(true);
  });

  const keepBoth = async (name: string) => {
    await b.write('/' + name, body('one'), opts);
    const e = await b.write('/' + name, body('two'), { ...opts, onCollision: 'keep-both' });
    expect(e.name).not.toBe(name);
    expect(Buffer.byteLength(e.name)).toBeLessThanOrEqual(255);
    expect(e.name.isWellFormed()).toBe(true);
    expect(Buffer.from(e.name, 'utf8').toString('utf8')).toBe(e.name);
    expect(await resolveInRoot(root, '/' + e.name)).toBe(join(realpathSync(root), e.name));
    expect(await text(Readable.from((await b.read('/' + e.name)).stream))).toBe('two');
    return e.name;
  };

  it('keeps a 20-byte extension on a 250-byte name', async () => {
    const ext = '.' + 'x'.repeat(19);
    const name = 'a'.repeat(250 - ext.length) + ext;
    expect(Buffer.byteLength(name)).toBe(250);
    expect(await keepBoth(name)).toMatch(new RegExp(`^a+ \\(1\\)\\${ext}$`));
  });

  it('never splits a multi-byte character', async () => {
    const name = '😀'.repeat(63); // 252 bytes, no extension
    const got = await keepBoth(name);
    expect(got).toMatch(/^(😀)+ \(1\)$/u);
  });

  it('drops an extension that leaves no room for the name', async () => {
    const name = 'a.' + 'x'.repeat(252); // the "extension" alone is 253 bytes
    expect(Buffer.byteLength(name)).toBe(254);
    const got = await keepBoth(name);
    expect(got.endsWith(' (1)')).toBe(true);
    expect(got.startsWith('a.x')).toBe(true);
  });

  it('drops an extension that would leave an empty stem', async () => {
    const name = '😀.' + 'x'.repeat(246); // stem 4 bytes, extension 247 bytes: " (1)" + extension leaves 4 bytes, one emoji fits
    expect(await keepBoth(name)).toBe('😀 (1).' + 'x'.repeat(246));
    const tight = '😀.' + 'x'.repeat(248); // extension 249 bytes leaves 2 bytes: no whole character fits before it
    const got = await keepBoth(tight);
    expect(got.endsWith(' (1)')).toBe(true);
    expect(got.startsWith('😀.x')).toBe(true);
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
  it('changes when a file is replaced with identical size and mtime (inode differs)', async () => {
    await b.write('/e.txt', body('same'), opts);
    const fixed = 1_700_000_000; // whole seconds: exact mtime on both files
    utimesSync(join(root, 'e.txt'), fixed, fixed);
    const before = statSync(join(root, 'e.txt'));
    const first = (await b.read('/e.txt')).etag;
    await b.write('/e.txt', body('same'), { ...opts, onCollision: 'replace' });
    utimesSync(join(root, 'e.txt'), fixed, fixed);
    const after = statSync(join(root, 'e.txt'));
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).not.toBe(before.ino);
    expect((await b.read('/e.txt')).etag).not.toBe(first);
  });
});
