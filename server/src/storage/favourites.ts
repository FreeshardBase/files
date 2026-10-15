import { posix } from 'node:path';
import type { Db } from '../db.ts';

/** A favourite row (#155). For `home`, `path` is kept current by the PATH_TABLES cascade. */
export type FavouriteRow = { id: number; source: string; path: string; type: 'file' | 'directory'; created_at: string;
  gone_at: string | null };
const COLUMNS = 'id, source, path, type, created_at, gone_at';

/** The member's favourites, in the order they were added. */
export function favouritesOf(db: Db, userId: string): FavouriteRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM favourites WHERE user_id = ? ORDER BY id`).all(userId) as FavouriteRow[];
}

/** Pins the item; an item already pinned keeps its row. `created` tells which happened. */
export function addFavourite(db: Db, userId: string, f: { source: string; path: string; type: 'file' | 'directory' }):
{ row: FavouriteRow; created: boolean } {
  return db.transaction(() => {
    const find = () => db.prepare(`SELECT ${COLUMNS} FROM favourites WHERE user_id = ? AND source = ? AND path = ?`)
      .get(userId, f.source, f.path) as FavouriteRow | undefined;
    const had = find();
    if (had) return { row: had, created: false };
    db.prepare('INSERT INTO favourites (user_id, source, path, type, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, f.source, f.path, f.type, new Date().toISOString());
    return { row: find()!, created: true };
  }).immediate();
}

/** Removes one of the member's own favourites; false if the member has none with that id. */
export function removeFavourite(db: Db, userId: string, id: number): boolean {
  return db.prepare('DELETE FROM favourites WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

// The item itself or anything beneath it, as in pathRefs.ts.
const UNDER = '(path = @p OR substr(path, 1, length(@p) + 1) = @p || \'/\')';

/**
 * An item of a source other than the home was moved through the app (the home's own moves are the PATH_TABLES cascade,
 * inside their transaction): the member's favourites of it and beneath it follow. Favourites already at the target are
 * stale and give way first.
 */
export function moveFavourites(db: Db, userId: string, source: string, from: string, to: string): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM favourites WHERE user_id = @u AND source = @s AND gone_at IS NULL AND ${UNDER}`)
      .run({ u: userId, s: source, p: to });
    db.prepare(`UPDATE favourites SET path = @to || substr(path, length(@p) + 1)
      WHERE user_id = @u AND source = @s AND gone_at IS NULL AND ${UNDER}`).run({ u: userId, s: source, p: from, to });
  }).immediate();
}

/** Items of a source other than the home were deleted through the app: the member's favourites of them go. */
export function deleteFavourites(db: Db, userId: string, source: string, paths: readonly string[]): void {
  db.transaction(() => {
    for (const p of paths) {
      db.prepare(`DELETE FROM favourites WHERE user_id = @u AND source = @s AND gone_at IS NULL AND ${UNDER}`)
        .run({ u: userId, s: source, p });
    }
  }).immediate();
}

export const favouriteName = (row: FavouriteRow): string => posix.basename(row.path);
