import { posix } from 'node:path';
import type { Entry } from '@files/shared';
import type { Db } from '../db.ts';
import { lookupMime } from './mime.ts';

/** One file or folder of a home as the index keeps it; `path` is home-relative. */
export type IndexedItem = { path: string; type: 'file' | 'directory'; size: number; modified: string };

/** How names and queries are compared: NFC, lower case. A query matches anywhere in the name. */
export const foldName = (s: string): string => s.normalize('NFC').toLowerCase();

export const indexedItem = (path: string, st: { isDirectory(): boolean; size: number; mtime: Date }): IndexedItem => ({
  path, type: st.isDirectory() ? 'directory' : 'file', size: st.isDirectory() ? 0 : st.size, modified: st.mtime.toISOString(),
});

const INSERT = `INSERT INTO name_index (user_id, path, name_fold, type, size, modified)
  VALUES (@userId, @path, @fold, @type, @size, @modified)`;

/**
 * Writes rows for `items`; called inside the transaction of the write that placed them. `replace` overwrites a row for
 * the same path (the item just written), `keep` leaves an existing one alone (folders above it that already existed).
 * Moves and deletes are the PATH_TABLES cascade.
 */
export function indexItems(db: Db, userId: string, items: readonly IndexedItem[], existing: 'replace' | 'keep' = 'replace'): void {
  const stmt = db.prepare(existing === 'keep' ? `${INSERT} ON CONFLICT (user_id, path) DO NOTHING`
    : `${INSERT} ON CONFLICT (user_id, path) DO UPDATE SET name_fold = excluded.name_fold, type = excluded.type,
      size = excluded.size, modified = excluded.modified`);
  for (const it of items) stmt.run({ userId, ...it, fold: foldName(posix.basename(it.path)) });
}

/** Replaces the member's whole index with `items`; called inside one transaction by the rebuild. */
export function replaceIndex(db: Db, userId: string, items: readonly IndexedItem[]): void {
  db.prepare('DELETE FROM name_index WHERE user_id = ?').run(userId);
  indexItems(db, userId, items);
}

type Row = { path: string; type: 'file' | 'directory'; size: number; modified: string };

/**
 * The member's items whose name contains `query`, at most `limit`: exact names first, then names that start with it,
 * then shorter names. instr() takes the query as plain text, so `%`, `_` and quotes match only themselves.
 */
export function searchIndex(db: Db, userId: string, query: string, limit: number): Entry[] {
  const rows = db.prepare(`SELECT path, type, size, modified FROM name_index
    WHERE user_id = @userId AND instr(name_fold, @q) > 0
    ORDER BY name_fold = @q DESC, substr(name_fold, 1, length(@q)) = @q DESC, length(name_fold), name_fold, path
    LIMIT @limit`).all({ userId, q: foldName(query), limit }) as Row[];
  return rows.map((r) => {
    const name = posix.basename(r.path);
    return { name, path: r.path, type: r.type, size: r.size, modified: r.modified,
      ...(r.type === 'file' ? { mime: lookupMime(name) } : {}) };
  });
}
