import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'files-db-'));

describe('openDb', () => {
  it('applies migrations once and records them', () => {
    const file = join(tmp(), 'f.db');
    openDb(file).close();
    const again = openDb(file);
    expect(again.prepare('SELECT name FROM schema_migrations').all()).toEqual([{ name: '001_init.sql' }]);
  });

  it('enables WAL and foreign keys', () => {
    const db = openDb(join(tmp(), 'f.db'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('rolls back a failing migration completely', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'm'));
    writeFileSync(join(dir, 'm', '001_ok.sql'), 'CREATE TABLE a (x INTEGER);');
    writeFileSync(join(dir, 'm', '002_bad.sql'), 'CREATE TABLE b (x INTEGER); SELECT nope FROM missing;');
    const file = join(dir, 'f.db');
    expect(() => openDb(file, join(dir, 'm'))).toThrow(/002_bad\.sql/);
    const raw = new Database(file);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name='b'").get()).toBeUndefined();
    expect(raw.prepare('SELECT name FROM schema_migrations').all()).toEqual([{ name: '001_ok.sql' }]);
  });
});
