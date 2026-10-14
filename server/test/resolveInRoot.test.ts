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
  it.each([
    '/../outside/secret.txt', '/docs/../../outside', '..', '/docs/..', 'a\u0000b', '/a\nb', '',
    '/.', '/docs/./a.txt', '/docs\\..\\..\\outside', '/a\\b', '/' + 'x'.repeat(256),
  ])('rejects %j as PATH_INVALID', async (p) => {
    expect(await code(resolveInRoot(root, p))).toBe('PATH_INVALID');
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
