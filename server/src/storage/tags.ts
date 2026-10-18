import { foldTag, MAX_TAGS_PER_ITEM, type ItemTags } from '@files/shared';
import type { Db } from '../db.ts';
import { AppError } from '../errors.ts';

/** A tag on one item (#212). For `home`, `path` is kept current by the PATH_TABLES cascade. */
export type TagRow = { id: number; source: string; path: string; type: 'file' | 'directory'; name: string; gone_at: string | null };
const COLUMNS = 'id, source, path, type, name, gone_at';
const LIVE = 'trash_id IS NULL';

/** The item's tags, in the order they were added. */
export function tagsOfItem(db: Db, userId: string, source: string, path: string): string[] {
  return db.prepare(`SELECT name FROM tags WHERE user_id = ? AND source = ? AND path = ? AND ${LIVE} ORDER BY id`)
    .pluck().all(userId, source, path) as string[];
}

/** The tags of the direct children of folder `dir` that have any. */
export function tagsInFolder(db: Db, userId: string, source: string, dir: string): ItemTags[] {
  const pre = dir === '/' ? '/' : `${dir}/`;
  const rows = db.prepare(`SELECT path, name FROM tags WHERE user_id = @u AND source = @s AND ${LIVE}
      AND substr(path, 1, length(@pre)) = @pre AND length(path) > length(@pre) AND instr(substr(path, length(@pre) + 1), '/') = 0
      ORDER BY id`).all({ u: userId, s: source, pre }) as { path: string; name: string }[];
  const by = new Map<string, string[]>();
  for (const r of rows) by.set(r.path, [...(by.get(r.path) ?? []), r.name]);
  return [...by].map(([path, tags]) => ({ path, tags }));
}

/** The member's tags with the number of live items carrying each, by name. */
export function tagSummary(db: Db, userId: string): { name: string; count: number }[] {
  const rows = db.prepare(`SELECT name_fold, count(*) AS count FROM tags WHERE user_id = ? AND ${LIVE} GROUP BY name_fold`)
    .all(userId) as { name_fold: string; count: number }[];
  return rows.map((r) => ({ name: spellingOf(db, userId, r.name_fold)!, count: r.count }))
    .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
}

/** How the member first spelled the tag `fold`, if they have it on any item (also in the trash). */
export function spellingOf(db: Db, userId: string, fold: string): string | undefined {
  return db.prepare('SELECT name FROM tags WHERE user_id = ? AND name_fold = ? ORDER BY id LIMIT 1').pluck().get(userId, fold) as string | undefined;
}

/** The first `limit` live items with the tag (those of a gone source included), in the order they were tagged. */
export function itemsWithTag(db: Db, userId: string, fold: string, limit: number): TagRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM tags WHERE user_id = ? AND name_fold = ? AND ${LIVE} ORDER BY id LIMIT ?`)
    .all(userId, fold, limit) as TagRow[];
}

/** The live items of one source with the tag (a smart folder scoped by a tag, #214), the first `limit` in tag order. */
export function taggedIn(db: Db, userId: string, source: string, fold: string, limit: number): { path: string; type: 'file' | 'directory' }[] {
  return db.prepare(`SELECT path, type FROM tags WHERE user_id = ? AND source = ? AND name_fold = ? AND ${LIVE} AND gone_at IS NULL
    ORDER BY id LIMIT ?`).all(userId, source, fold, limit) as { path: string; type: 'file' | 'directory' }[];
}

/**
 * Puts the tag `name` (already normalised) on every item, all or nothing: an item that would get its 21st tag refuses
 * the whole call (`TAG_LIMIT`). An item that already has it keeps its row; the member's first spelling is used.
 */
export function addTag(db: Db, userId: string, source: string, items: readonly { path: string; type: 'file' | 'directory' }[], name: string): void {
  const fold = foldTag(name);
  db.transaction(() => {
    const spelled = spellingOf(db, userId, fold) ?? name;
    const has = db.prepare(`SELECT 1 FROM tags WHERE user_id = ? AND source = ? AND path = ? AND name_fold = ? AND ${LIVE}`).pluck();
    const count = db.prepare(`SELECT count(*) FROM tags WHERE user_id = ? AND source = ? AND path = ? AND ${LIVE}`).pluck();
    const insert = db.prepare(`INSERT INTO tags (user_id, source, path, type, name, name_fold, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const now = new Date().toISOString();
    for (const it of items) {
      if (has.get(userId, source, it.path, fold)) continue;
      if ((count.get(userId, source, it.path) as number) >= MAX_TAGS_PER_ITEM) throw new AppError('TAG_LIMIT', { max: MAX_TAGS_PER_ITEM });
      insert.run(userId, source, it.path, it.type, spelled, fold, now);
    }
  }).immediate();
}

/** Takes the tag off the member's items; also rows of a missing item or a gone source. */
export function removeTag(db: Db, userId: string, source: string, paths: readonly string[], name: string): void {
  const fold = foldTag(name.trim());
  db.transaction(() => {
    const stmt = db.prepare(`DELETE FROM tags WHERE user_id = ? AND source = ? AND path = ? AND name_fold = ? AND ${LIVE}`);
    for (const p of paths) stmt.run(userId, source, p, fold);
  }).immediate();
}

// The item itself or anything beneath it, as in pathRefs.ts.
const UNDER = '(path = @p OR substr(path, 1, length(@p) + 1) = @p || \'/\')';

/**
 * An item of a source other than the home was moved through the app (the home's own moves are the PATH_TABLES cascade):
 * the member's tags of it and beneath it follow. Tags already at the target are stale and give way first.
 */
export function moveTags(db: Db, userId: string, source: string, from: string, to: string): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM tags WHERE user_id = @u AND source = @s AND gone_at IS NULL AND ${UNDER}`).run({ u: userId, s: source, p: to });
    db.prepare(`UPDATE tags SET path = @to || substr(path, length(@p) + 1)
      WHERE user_id = @u AND source = @s AND gone_at IS NULL AND ${UNDER}`).run({ u: userId, s: source, p: from, to });
  }).immediate();
}

/** Items of a source other than the home were deleted through the app (into the provider's trash): their tags go. */
export function deleteTags(db: Db, userId: string, source: string, paths: readonly string[]): void {
  db.transaction(() => {
    const stmt = db.prepare(`DELETE FROM tags WHERE user_id = @u AND source = @s AND gone_at IS NULL AND ${UNDER}`);
    for (const p of paths) stmt.run({ u: userId, s: source, p });
  }).immediate();
}
