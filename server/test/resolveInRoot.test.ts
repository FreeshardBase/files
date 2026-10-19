import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInRoot, normalizeUserPath } from '../src/storage/resolveInRoot.ts';

let root: string; let outside: string;
beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'files-rir-')));
  root = join(base, 'home'); outside = join(base, 'outside');
  mkdirSync(join(root, 'docs'), { recursive: true }); mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'x');
});

const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as { code: string }).code; } };

describe('resolveInRoot', () => {
  it('resolves a normal path inside the root', async () => {
    expect(await resolveInRoot(root, '/docs/a.txt')).toBe(join(root, 'docs', 'a.txt'));
  });
  it('resolves "/" to the root itself', async () => {
    expect(await resolveInRoot(root, '/')).toBe(root);
  });
  it('refuses U+FFFD in a home path, which a cloud path may hold (#379)', async () => {
    expect(await code(resolveInRoot(root, '/docs/a�.txt'))).toBe('PATH_INVALID');
    expect(normalizeUserPath('/docs/a�.txt')).toBe('/docs/a�.txt');
  });
  it.each([
    '/../outside/secret.txt', '/docs/../../outside', '..', '/docs/..', 'a\u0000b', '/a\nb', '',
    '/.', '/docs/./a.txt', '/docs\\..\\..\\outside', '/a\\b', '/' + 'x'.repeat(256),
  ])('rejects %j as PATH_INVALID', async (p) => {
    expect(await code(resolveInRoot(root, p))).toBe('PATH_INVALID');
  });
  it.each([
    '/a\u0085b', '/gpj\u202e.exe', '/a\u200eb', '/a\u061cb', '/a\u2066b', '/\ud800', '/a\udc00b',
    '/' + Array.from({ length: 20 }, () => 'x'.repeat(250)).join('/'),
  ])('rejects control, bidi, lone surrogate and overlong %j', async (p) => {
    expect(await code(resolveInRoot(root, p))).toBe('PATH_INVALID');
  });
  it('maps ENOTDIR to NOT_A_DIRECTORY when a file is used as a directory', async () => {
    writeFileSync(join(root, 'f.txt'), 'x');
    expect(await code(resolveInRoot(root, '/f.txt/x'))).toBe('NOT_A_DIRECTORY');
  });
  it('rethrows a missing root', async () => {
    expect(await code(resolveInRoot(join(root, 'nope'), '/a'))).toBe('ENOENT');
  });
  it('works with a symlinked root and returns a path under its realpath', async () => {
    const link = join(outside, 'rootlink');
    symlinkSync(root, link);
    expect((await resolveInRoot(link, '/docs/a.txt')).startsWith(realpathSync(root) + '/')).toBe(true);
  });
  it('rejects an overlong path under a deep existing prefix with PATH_INVALID, not ENAMETOOLONG', async () => {
    const seg = 'y'.repeat(200);
    let dir = root; let len = Buffer.byteLength(root);
    while (len + 201 < 4000) { dir = join(dir, seg); len += 201; mkdirSync(dir); }
    const deep = '/' + Array.from({ length: Math.floor((len - Buffer.byteLength(root)) / 201) }, () => seg).join('/');
    expect(await code(resolveInRoot(root, deep + '/' + 'z'.repeat(200) + '/' + 'z'.repeat(200)))).toBe('PATH_INVALID');
  });
  it('rejects a symlinked leaf', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    expect(await code(resolveInRoot(root, '/link.txt'))).toBe('PATH_SYMLINK');
  });
  it('rejects a symlinked intermediate directory', async () => {
    symlinkSync(outside, join(root, 'docs', 'out'));
    expect(await code(resolveInRoot(root, '/docs/out/secret.txt'))).toBe('PATH_SYMLINK');
  });
  it('rejects a symlinked intermediate even when the leaf does not exist yet', async () => {
    symlinkSync(outside, join(root, 'out'));
    expect(await code(resolveInRoot(root, '/out/new.txt'))).toBe('PATH_SYMLINK');
  });
  it('rejects a root that is itself reached through a sibling prefix', async () => {
    mkdirSync(root + '2');
    expect(await code(resolveInRoot(root, '/../home2/x'))).toBe('PATH_INVALID');
  });
  it('allows non-existing nested paths (for mkdir/upload)', async () => {
    expect(await resolveInRoot(root, '/new/deeper/file.txt')).toBe(join(root, 'new', 'deeper', 'file.txt'));
  });
});

describe('normalizeUserPath', () => {
  it('normalises NFD to NFC and trims trailing slash', () => {
    expect(normalizeUserPath('/Pru\u0308fung/')).toBe('/Pr\u00fcfung');
  });
  it('keeps names with spaces, %, # and emoji', () => {
    expect(normalizeUserPath('/a b/50% #1 🎉.txt')).toBe('/a b/50% #1 🎉.txt');
  });
});
