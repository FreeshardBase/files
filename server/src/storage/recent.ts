import { posix } from 'node:path';
import type { RecentItem } from '@files/shared';
import type { Db } from '../db.ts';
import { lookupMime } from './mime.ts';

/** Entries kept per member; writing one more drops the oldest. */
export const RECENT_CAP = 100;

type RecentRow = { path: string; type: 'file' | 'directory'; changed_at: string };

/**
 * Records that the member wrote `path`; called inside the transaction of the write. A path written again moves to the
 * top (delete, then insert, so its id is the newest). Moves and deletes of recorded paths are the PATH_TABLES cascade.
 */
export function recordRecent(db: Db, userId: string, path: string, type: 'file' | 'directory'): void {
  db.prepare('DELETE FROM recent WHERE user_id = ? AND path = ?').run(userId, path);
  db.prepare('INSERT INTO recent (user_id, path, type, changed_at) VALUES (?, ?, ?, ?)')
    .run(userId, path, type, new Date().toISOString());
  db.prepare(`DELETE FROM recent WHERE user_id = @u AND id NOT IN
    (SELECT id FROM recent WHERE user_id = @u ORDER BY id DESC LIMIT @cap)`).run({ u: userId, cap: RECENT_CAP });
}

/** The member's recent items in the home, newest first. */
export function recentItems(db: Db, userId: string): RecentItem[] {
  const rows = db.prepare('SELECT path, type, changed_at FROM recent WHERE user_id = ? ORDER BY id DESC').all(userId) as RecentRow[];
  return rows.map((r) => {
    const name = posix.basename(r.path);
    return { source: 'home', name, path: r.path, type: r.type, changedAt: r.changed_at,
      ...(r.type === 'file' ? { mime: lookupMime(name) } : {}) };
  });
}
