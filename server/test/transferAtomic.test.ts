import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReadStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBackend } from '../src/storage/local.ts';
import { testIndex } from './support/homeIndex.ts';

// Failures are injected by SQLite triggers on the statements that run after the filesystem step. Without the one
// transaction around both, the statements that ran before the failure would stay and point at a file that is not
// there (#117).
const TABLES = [
  { table: 'test_favs', ownerColumn: 'user_id', pathColumn: 'path' },
  { table: 'test_shares', ownerColumn: 'owner_id', pathColumn: 'target' },
];

let root: string; let idx: ReturnType<typeof testIndex>; let b: LocalBackend;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'files-atomic-'));
  idx = testIndex(TABLES);
  idx.db.exec(`
    CREATE TABLE test_favs (user_id TEXT NOT NULL, path TEXT NOT NULL);
    CREATE TABLE test_shares (owner_id TEXT NOT NULL, target TEXT NOT NULL);`);
  b = new LocalBackend(root, idx);
});
afterEach(() => { idx.close(); rmSync(root, { recursive: true, force: true }); });

const err = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as Error).message; } };
const rows = () => ({
  favs: idx.db.prepare('SELECT path FROM test_favs ORDER BY 1').pluck().all(),
  shares: idx.db.prepare('SELECT target FROM test_shares ORDER BY 1').pluck().all(),
  trash: idx.db.prepare('SELECT original_path FROM trash ORDER BY 1').pluck().all(),
});
const addRows = (...paths: string[]) => {
  for (const p of paths) {
    idx.db.prepare('INSERT INTO test_favs VALUES (?, ?)').run(idx.userId, p);
    idx.db.prepare('INSERT INTO test_shares VALUES (?, ?)').run(idx.userId, p);
  }
};
const put = (rel: string, data: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), data); };
const trashDir = () => readdirSync(join(root, '.files', 'trash'));

describe('a failure after the filesystem step leaves files and rows consistent', () => {
  it('delete: the trash row fails, so the file is back and its rows are kept', async () => {
    put('/docs/a.txt', 'A'); put('/docs/b.txt', 'B');
    addRows('/docs/a.txt', '/docs/b.txt');
    idx.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON trash WHEN NEW.original_path = '/docs/b.txt'
      BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
    const before = rows();
    expect(await err(b.delete(['/docs/a.txt', '/docs/b.txt']))).toBe('injected');
    expect(readFileSync(join(root, 'docs', 'a.txt'), 'utf8')).toBe('A');
    expect(readFileSync(join(root, 'docs', 'b.txt'), 'utf8')).toBe('B');
    expect(trashDir()).toEqual([]);
    expect(rows()).toEqual(before);
  });
  it('move: the second table fails, so the folder is back and no row points at the new path', async () => {
    put('/A/x.txt', 'X'); mkdirSync(join(root, 'Z'));
    addRows('/A', '/A/x.txt');
    idx.db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON test_shares BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
    const before = rows();
    expect(await err(b.move('/A', '/Z/A', 'fail'))).toBe('injected');
    expect(readFileSync(join(root, 'A', 'x.txt'), 'utf8')).toBe('X');
    expect(readdirSync(join(root, 'Z'))).toEqual([]);
    expect(rows()).toEqual(before);
  });
  it('move with replace: the replaced target comes back from the trash too', async () => {
    put('/new.txt', 'new'); put('/to/new.txt', 'old');
    addRows('/new.txt', '/to/new.txt');
    idx.db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON test_shares BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
    const before = rows();
    expect(await err(b.move('/new.txt', '/to/new.txt', 'replace'))).toBe('injected');
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('new');
    expect(readFileSync(join(root, 'to', 'new.txt'), 'utf8')).toBe('old');
    expect(trashDir()).toEqual([]);
    expect(rows()).toEqual(before);
  });
  it('copy with replace: the trash row fails, so the old target stays and the copy is gone', async () => {
    put('/src.txt', 'new'); put('/dst.txt', 'old');
    addRows('/dst.txt');
    idx.db.exec(`CREATE TRIGGER boom BEFORE INSERT ON trash BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
    const before = rows();
    expect(await err(b.copy('/src.txt', '/dst.txt', 'replace'))).toBe('injected');
    expect(readFileSync(join(root, 'dst.txt'), 'utf8')).toBe('old');
    expect(trashDir()).toEqual([]);
    expect(readdirSync(join(root, '.files', 'tmp'))).toEqual([]);
    expect(rows()).toEqual(before);
  });
});

describe('copy memory', () => {
  it('copies a 200 MB file with bounded memory', async () => {
    const size = 200 * 1024 * 1024;
    writeFileSync(join(root, 'big.bin'), 'head');
    truncateSync(join(root, 'big.bin'), size);
    const hash = (p: string) => new Promise<string>((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(p).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
    const mem = () => { const m = process.memoryUsage(); return m.arrayBuffers + m.heapUsed; };
    const base = mem(); let peak = base;
    const sampler = setInterval(() => { peak = Math.max(peak, mem()); }, 1);
    try {
      const e = await b.copy('/big.bin', '/big copy.bin', 'fail');
      expect(e.size).toBe(size);
    } finally { clearInterval(sampler); }
    peak = Math.max(peak, mem());
    expect(peak - base).toBeLessThan(32 * 1024 * 1024);
    expect(await hash(join(root, 'big copy.bin'))).toBe(await hash(join(root, 'big.bin')));
  });
});
