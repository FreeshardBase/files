import Database from 'better-sqlite3';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldName } from './storage/nameIndex.ts';

export type Db = Database.Database;
export const DEFAULT_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function openDb(file: string, migrationsDir = DEFAULT_MIGRATIONS): Db {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // The name index's fold of a path's own name (#235), for a migration that rewrites the stored folds.
  db.function('files_name_fold', { deterministic: true }, (path: unknown) => foldName(posix.basename(String(path))));
  migrate(db, migrationsDir);
  return db;
}

export function migrate(db: Db, dir: string): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const isDone = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').pluck();
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    // Check and apply under one write lock: a second process starting at the same time waits, then sees it done.
    const apply = db.transaction(() => {
      if (isDone.get(f) !== undefined) return;
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
    });
    try { apply.immediate(); }
    catch (err) { throw new Error(`Migration ${f} failed: ${(err as Error).message}`, { cause: err }); }
  }
}
