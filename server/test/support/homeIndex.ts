import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db.ts';
import type { HomeIndex } from '../../src/storage/local.ts';
import type { PathTable, TrashTable } from '../../src/storage/pathRefs.ts';

/** A real, migrated database in a temp dir with one user (`testuser`), for driving a LocalBackend directly. */
export function testIndex(pathTables: readonly PathTable[] = [], trashTables: readonly TrashTable[] = []): HomeIndex & { close(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'files-idx-'));
  const db = openDb(join(dir, 'files.db'));
  const userId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (id, iss, sub, display_name, email, role, created_at, last_login)
    VALUES (?, 'https://idp.example.com', 'testuser', 'Test User', 'testuser@example.com', 'member', ?, ?)`).run(userId, now, now);
  return { db, userId, pathTables, trashTables, versions: { maxCount: 10, maxBytes: 1024 ** 3 },
    etagKey: randomBytes(32), close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
