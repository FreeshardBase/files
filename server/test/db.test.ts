import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { DEFAULT_MIGRATIONS, openDb } from '../src/db.ts';

const dbTs = fileURLToPath(new URL('../src/db.ts', import.meta.url));

const tmp = () => mkdtempSync(join(tmpdir(), 'files-db-'));

describe('openDb', () => {
  it('applies migrations once and records them', () => {
    const file = join(tmp(), 'f.db');
    openDb(file).close();
    const again = openDb(file);
    try {
      expect(again.prepare('SELECT name FROM schema_migrations').all()).toEqual([{ name: '001_init.sql' }, { name: '002_trash.sql' }, { name: '003_trash_expiry.sql' }, { name: '004_uploads.sql' }, { name: '005_recent.sql' }, { name: '006_thumbnails.sql' }, { name: '007_name_index.sql' }, { name: '008_shares.sql' }, { name: '009_public_links.sql' }, { name: '010_connections.sql' }, { name: '011_connection_library.sql' }, { name: '012_transfers.sql' }, { name: '013_migrations.sql' }, { name: '014_versions.sql' }, { name: '015_favourites.sql' }, { name: '016_webdav.sql' }, { name: '017_user_settings.sql' }, { name: '018_user_sort.sql' }, { name: '019_file_requests.sql' }, { name: '020_tags.sql' }, { name: '021_smart_folders.sql' }, { name: '022_comments.sql' }, { name: '023_rename_jobs.sql' }, { name: '024_content_hashes.sql' }, { name: '025_user_layout.sql' }, { name: '026_name_fold_accents.sql' }, { name: '027_comments_author.sql' }, { name: '028_display_name_not_sub.sql' }, { name: '029_users_login.sql' }, { name: '030_import_jobs.sql' }, { name: '031_transfer_renames.sql' }, { name: '032_request_file_ceiling.sql' }]);
    } finally { again.close(); }
  });

  it('clears a display name that is the login’s `sub` and keeps real names (#337)', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'm'));
    for (const f of readdirSync(DEFAULT_MIGRATIONS).filter((n) => n < '028')) copyFileSync(join(DEFAULT_MIGRATIONS, f), join(dir, 'm', f));
    const file = join(dir, 'f.db');
    const old = openDb(file, join(dir, 'm'));
    const user = old.prepare(`INSERT INTO users (id, iss, sub, display_name, role, created_at, last_login)
      VALUES (?, 'https://idp.example.com', ?, ?, 'member', 'now', 'now')`);
    user.run('u1', '317b500d-c0d1-402b-9a1e-000000000000', '317b500d-c0d1-402b-9a1e-000000000000');
    user.run('u2', 'testuser', 'Test User');
    old.close();

    const db = openDb(file);
    try {
      expect(db.prepare('SELECT id, display_name FROM users ORDER BY id').all())
        .toEqual([{ id: 'u1', display_name: '' }, { id: 'u2', display_name: 'Test User' }]);
    } finally { db.close(); }
  });

  it('caps a file request\'s file limit at the ceiling of 1000 and keeps lower ones and none (#401)', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'm'));
    for (const f of readdirSync(DEFAULT_MIGRATIONS).filter((n) => n < '032')) copyFileSync(join(DEFAULT_MIGRATIONS, f), join(dir, 'm', f));
    const file = join(dir, 'f.db');
    const old = openDb(file, join(dir, 'm'));
    old.prepare(`INSERT INTO users (id, iss, sub, display_name, role, created_at, last_login)
      VALUES ('u1', 'https://idp.example.com', 'testuser', 'Test User', 'member', 'now', 'now')`).run();
    const request = old.prepare(`INSERT INTO file_requests (id, token, owner_id, source, path, label, max_files, created_at)
      VALUES (?, ?, 'u1', 'home', '/inbox', '', ?, 'now')`);
    for (const [id, max] of [['a', 100_000], ['b', 1000], ['c', 7], ['d', null]] as const) request.run(id, `t-${id}`, max);
    // Visitor files: placed, open, reserved, and one whose upload was dropped before it was placed.
    old.prepare(`INSERT INTO uploads (id, user_id, source, path, length, received, on_collision, created_at, expires_at)
      VALUES ('up-open', 'u1', 'home', '/inbox/b.bin', 1, 0, 'keep-both', 'now', 'later')`).run();
    const visitorFile = old.prepare(`INSERT INTO file_request_uploads (id, request_id, visitor, upload_id, name, length, created_at, placed_at)
      VALUES (?, 'd', 'v', ?, 'f.bin', 1, 'now', ?)`);
    for (const [id, upload, placed] of [['placed', 'up-gone-1', 'now'], ['open', 'up-open', null], ['reserved', null, null],
      ['dropped', 'up-gone-2', null]] as const) visitorFile.run(id, upload, placed);
    old.close();

    const db = openDb(file);
    try {
      expect(db.prepare('SELECT id, max_files FROM file_requests ORDER BY id').all()).toEqual([
        { id: 'a', max_files: 1000 }, { id: 'b', max_files: 1000 }, { id: 'c', max_files: 7 }, { id: 'd', max_files: null }]);
      expect(db.prepare('SELECT id FROM file_request_uploads ORDER BY id').pluck().all()).toEqual(['open', 'placed', 'reserved']);
    } finally { db.close(); }
  });

  it('keeps every transfer job and item when it rebuilds the tables for rename jobs (#215), with their references', () => {
    // A database migrated up to 022 that holds a migration, its cleanup and their items.
    const dir = tmp();
    mkdirSync(join(dir, 'm'));
    for (const f of readdirSync(DEFAULT_MIGRATIONS).filter((n) => n < '023')) copyFileSync(join(DEFAULT_MIGRATIONS, f), join(dir, 'm', f));
    const file = join(dir, 'f.db');
    const old = openDb(file, join(dir, 'm'));
    old.prepare(`INSERT INTO users (id, iss, sub, display_name, role, created_at, last_login)
      VALUES ('u1', 'https://idp.example.com', 'testuser', 'Test User', 'member', 'now', 'now')`).run();
    const job = old.prepare(`INSERT INTO transfer_jobs (id, user_id, kind, origin, mode, from_source, to_source, dir, status, created_at)
      VALUES (?, 'u1', ?, ?, ?, 'conn:x', 'home', '/', 'completed', '2026-10-17T00:00:00.000Z')`);
    job.run('a'.repeat(32), 'migration', null, 'copy');
    job.run('b'.repeat(32), 'cleanup', 'a'.repeat(32), 'move');
    old.prepare(`INSERT INTO transfer_items (job_id, seq, from_path, to_path, on_collision, type, placed, status, bytes, sha256, verified)
      VALUES (?, 0, '/x.txt', '/M/x.txt', 'fail', 'file', '/M/x.txt', 'done', 3, 'abc', 'size sha256')`).run('a'.repeat(32));
    old.close();

    const db = openDb(file);
    try {
      expect(db.prepare('SELECT id, kind, origin, mode FROM transfer_jobs ORDER BY id').all()).toEqual([
        { id: 'a'.repeat(32), kind: 'migration', origin: null, mode: 'copy' }, { id: 'b'.repeat(32), kind: 'cleanup', origin: 'a'.repeat(32), mode: 'move' }]);
      expect(db.prepare('SELECT job_id, placed, bytes, sha256, verified FROM transfer_items').all())
        .toEqual([{ job_id: 'a'.repeat(32), placed: '/M/x.txt', bytes: 3, sha256: 'abc', verified: 'size sha256' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      // A rename job is allowed now; the references still act: deleting a job takes its items and clears an origin.
      db.prepare(`INSERT INTO transfer_jobs (id, user_id, kind, mode, from_source, to_source, dir, status, created_at)
        VALUES (?, 'u1', 'rename', 'move', 'home', 'home', '/', 'running', 'now')`).run('c'.repeat(32));
      db.prepare('DELETE FROM transfer_jobs WHERE id = ?').run('a'.repeat(32));
      expect(db.prepare('SELECT count(*) FROM transfer_items').pluck().get()).toBe(0);
      expect(db.prepare('SELECT origin FROM transfer_jobs WHERE id = ?').pluck().get('b'.repeat(32))).toBeNull();
    } finally { db.close(); }
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
