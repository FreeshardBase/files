import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

// Records every rename, link and fsync the backend performs, in order. A replace renames inside its transaction (#154).
const log: string[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn((from: string, to: string) => { fs.renameSync(from, to); log.push(`rename ${to}`); }) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: vi.fn(async (from: string, to: string) => { await fs.rename(from, to); log.push(`rename ${to}`); }),
    link: vi.fn(async (from: string, to: string) => { await fs.link(from, to); log.push(`link ${to}`); }),
    open: vi.fn(async (...args: Parameters<typeof fs.open>) => {
      const fh = await fs.open(...args);
      const sync = fh.sync.bind(fh);
      fh.sync = async () => { await sync(); log.push(`sync ${String(args[0])}`); };
      return fh;
    }),
  };
});

const { LocalBackend } = await import('../src/storage/local.ts');
const { testIndex } = await import('./support/homeIndex.ts');
const body = (s: string) => Readable.from([Buffer.from(s)]);

describe('LocalBackend.write durability', () => {
  it.each(['replace', 'fail', 'keep-both'] as const)('fsyncs the target folder after placing the file (%s)', async (onCollision) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'files-fsync-')));
    const b = new LocalBackend(root, testIndex());
    if (onCollision === 'keep-both') await b.write('/sub/a.txt', body('one'), { onCollision: 'fail', maxBytes: 1024 });
    log.length = 0;
    const e = await b.write('/sub/a.txt', body('two'), { onCollision, maxBytes: 1024 });
    const placed = log.findIndex((l) => l === `rename ${join(root, 'sub', e.name)}` || l === `link ${join(root, 'sub', e.name)}`);
    expect(placed).toBeGreaterThanOrEqual(0);
    expect(log.slice(placed + 1)).toContain(`sync ${join(root, 'sub')}`);
  });
});
