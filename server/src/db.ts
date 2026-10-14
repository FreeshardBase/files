import Database from 'better-sqlite3';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;
export const DEFAULT_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function openDb(file: string, migrationsDir = DEFAULT_MIGRATIONS): Db {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, migrationsDir);
  return db;
}

export function migrate(db: Db, dir: string): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[]);
  const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
    });
    try { apply(); }
    catch (err) { throw new Error(`Migration ${f} failed: ${(err as Error).message}`, { cause: err }); }
  }
}
