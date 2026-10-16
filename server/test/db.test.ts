import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.ts';

const dbTs = fileURLToPath(new URL('../src/db.ts', import.meta.url));

const tmp = () => mkdtempSync(join(tmpdir(), 'files-db-'));

describe('openDb', () => {
  it('applies migrations once and records them', () => {
    const file = join(tmp(), 'f.db');
    openDb(file).close();
    const again = openDb(file);
    try {
      expect(again.prepare('SELECT name FROM schema_migrations').all()).toEqual([{ name: '001_init.sql' }, { name: '002_trash.sql' }, { name: '003_trash_expiry.sql' }, { name: '004_uploads.sql' }, { name: '005_recent.sql' }, { name: '006_thumbnails.sql' }, { name: '007_name_index.sql' }, { name: '008_shares.sql' }, { name: '009_public_links.sql' }, { name: '010_connections.sql' }, { name: '011_connection_library.sql' }, { name: '012_transfers.sql' }, { name: '013_migrations.sql' }, { name: '014_versions.sql' }, { name: '015_favourites.sql' }, { name: '016_webdav.sql' }, { name: '017_user_settings.sql' }, { name: '018_user_sort.sql' }]);
    } finally { again.close(); }
  });

  it('enables WAL and foreign keys', () => {
    const db = openDb(join(tmp(), 'f.db'));
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally { db.close(); }
  });

  it('rolls back a failing migration completely', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'm'));
    writeFileSync(join(dir, 'm', '001_ok.sql'), 'CREATE TABLE a (x INTEGER);');
    writeFileSync(join(dir, 'm', '002_bad.sql'), 'CREATE TABLE b (x INTEGER); SELECT nope FROM missing;');
    const file = join(dir, 'f.db');
    expect(() => openDb(file, join(dir, 'm'))).toThrow(/002_bad\.sql/);
    const raw = new Database(file);
    try {
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name='b'").get()).toBeUndefined();
      expect(raw.prepare('SELECT name FROM schema_migrations').all()).toEqual([{ name: '001_ok.sql' }]);
    } finally { raw.close(); }
  });

  it('two processes starting at once apply a pending migration exactly once and both start', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'none'));
    mkdirSync(join(dir, 'm'));
    writeFileSync(join(dir, 'm', '001_count.sql'), 'CREATE TABLE IF NOT EXISTS applied (x INTEGER); INSERT INTO applied VALUES (1);');
    const file = join(dir, 'f.db');
    openDb(file, join(dir, 'none')).close(); // an existing database, with the migration still pending

    // Hold the write lock so both instances get as far as the lock before either can apply anything.
    const holder = new Database(file);
    holder.exec('BEGIN IMMEDIATE');
    const instances = [0, 1].map(() => startInstance(file, join(dir, 'm')));
    await Promise.all(instances.map((i) => i.reachedOpen));
    await new Promise((r) => setTimeout(r, 1000));
    holder.exec('ROLLBACK');
    holder.close();

    const results = await Promise.all(instances.map((i) => i.exit));
    expect(results).toEqual([{ code: 0, stderr: '' }, { code: 0, stderr: '' }]);
    const raw = new Database(file);
    try {
      expect(raw.prepare('SELECT name FROM schema_migrations').all()).toEqual([{ name: '001_count.sql' }]);
      expect(raw.prepare('SELECT count(*) FROM applied').pluck().get()).toBe(1);
    } finally { raw.close(); }
  }, 20000);
});

// A separate process that opens the database the way main.ts does; it prints "open" just before openDb.
function startInstance(file: string, migrations: string) {
  const script = `import { openDb } from ${JSON.stringify(dbTs)};
    process.stdout.write('open\\n');
    openDb(${JSON.stringify(file)}, ${JSON.stringify(migrations)}).close();`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  const reachedOpen = new Promise<void>((resolve) => {
    child.stdout.on('data', (d: Buffer) => { if (d.toString().includes('open')) resolve(); });
  });
  const exit = new Promise<{ code: number | null; stderr: string }>((resolve) => child.on('close', (code) => resolve({ code, stderr })));
  return { reachedOpen: Promise.race([reachedOpen, exit.then(() => { throw new Error(`instance exited early: ${stderr}`); })]), exit };
}
