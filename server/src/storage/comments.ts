import { MAX_COMMENTS_PER_AUTHOR, MAX_COMMENTS_PER_ITEM, type Comment } from '@files/shared';
import type { Db } from '../db.ts';
import { AppError } from '../errors.ts';
import { parseSource } from './resolveSource.ts';
import { grantedShare } from './shares.ts';

/**
 * Where an item lives for its owner (#213): the owner, their own source (`home` or `conn:<id>`) and their path. A
 * comment thread hangs off this key, so the owner and every grantee of the item reach the same thread.
 */
export type ItemKey = { owner: string; source: string; path: string };

/**
 * How the caller's paths in `source` map to item keys. Their home and connections are their own; a share maps onto the
 * owner's item beneath the share's root (read once, so a mapping taken before a provider change still holds after it).
 * A share not granted to the caller is SOURCE_NOT_FOUND, as in `resolveSource`.
 */
export function keysOf(db: Db, userId: string, source: string): (path: string) => ItemKey {
  const ref = parseSource(source);
  if (ref.kind !== 'share') return (path) => ({ owner: userId, source, path });
  const row = grantedShare(db, ref.id, userId);
  if (!row) throw new AppError('SOURCE_NOT_FOUND');
  return (path) => ({ owner: row.owner_id, source: row.source, path: path === '/' ? row.path : row.path + path });
}

type Row = { id: number; author_id: string; display_name: string; text: string; created_at: string; edited_at: string | null };
const LIVE = 'trash_id IS NULL';
// The item's live comments (`c` is the comments table in SELECT).
const ITEM = 'c.owner_id = @owner AND c.source = @source AND c.path = @path AND c.trash_id IS NULL';

const toComment = (r: Row, key: ItemKey, viewer: string): Comment => ({
  id: r.id, author: { id: r.author_id, displayName: r.display_name }, text: r.text, created: r.created_at, edited: r.edited_at,
  mine: r.author_id === viewer, canDelete: r.author_id === viewer || key.owner === viewer,
});

const SELECT = `SELECT c.id, c.author_id, u.display_name, c.text, c.created_at, c.edited_at FROM comments c
  JOIN users u ON u.id = c.author_id`;

/** The item's thread as `viewer` sees it, oldest first. */
export function threadOf(db: Db, key: ItemKey, viewer: string): Comment[] {
  const rows = db.prepare(`${SELECT} WHERE ${ITEM} ORDER BY c.id`).all(key) as Row[];
  return rows.map((r) => toComment(r, key, viewer));
}

/** One comment of the item's thread, or undefined when the id names none of it. */
export function commentOf(db: Db, key: ItemKey, id: number, viewer: string): Comment | undefined {
  const r = db.prepare(`${SELECT} WHERE c.id = @id AND ${ITEM}`).get({ ...key, id }) as Row | undefined;
  return r && toComment(r, key, viewer);
}

/**
 * A new comment, unless the item already has MAX_COMMENTS_PER_ITEM live ones or the author has written
 * MAX_COMMENTS_PER_AUTHOR, live or in the trash: then COMMENT_LIMIT (#308). Counted and inserted under one write lock.
 */
export function addComment(db: Db, key: ItemKey, authorId: string, text: string): Comment {
  return db.transaction(() => {
    const onItem = db.prepare(`SELECT count(*) FROM comments c WHERE ${ITEM}`).pluck().get(key) as number;
    if (onItem >= MAX_COMMENTS_PER_ITEM) throw new AppError('COMMENT_LIMIT', { max: MAX_COMMENTS_PER_ITEM });
    // Trashed rows count too: they stay in the database until the trash is purged (#308).
    const byAuthor = db.prepare('SELECT count(*) FROM comments WHERE author_id = ?').pluck().get(authorId) as number;
    if (byAuthor >= MAX_COMMENTS_PER_AUTHOR) throw new AppError('COMMENT_LIMIT', { max: MAX_COMMENTS_PER_AUTHOR });
    const { lastInsertRowid } = db.prepare(`INSERT INTO comments (owner_id, source, path, author_id, text, created_at)
      VALUES (@owner, @source, @path, @author, @text, @now)`).run({ ...key, author: authorId, text, now: new Date().toISOString() });
    return commentOf(db, key, Number(lastInsertRowid), authorId)!;
  }).immediate();
}

export function editComment(db: Db, id: number, text: string): void {
  db.prepare('UPDATE comments SET text = ?, edited_at = ? WHERE id = ?').run(text, new Date().toISOString(), id);
}

export function deleteComment(db: Db, id: number): void {
  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
}

/** How many comments each direct child of the folder `dir` has, for those that have any. */
export function countsIn(db: Db, dir: ItemKey): { path: string; count: number }[] {
  const pre = dir.path === '/' ? '/' : `${dir.path}/`;
  return db.prepare(`SELECT path, count(*) AS count FROM comments WHERE owner_id = @owner AND source = @source AND ${LIVE}
      AND substr(path, 1, length(@pre)) = @pre AND length(path) > length(@pre) AND instr(substr(path, length(@pre) + 1), '/') = 0
      GROUP BY path`).all({ owner: dir.owner, source: dir.source, pre }) as { path: string; count: number }[];
}

// The item itself or anything beneath it, as in pathRefs.ts.
const UNDER = 'owner_id = @owner AND source = @source AND (path = @p OR substr(path, 1, length(@p) + 1) = @p || \'/\')';

/**
 * An item was moved through the app in a source other than the owner's home (whose moves are the PATH_TABLES cascade):
 * the threads of it and beneath it follow. Rows already at the target are stale and give way first.
 */
export function moveComments(db: Db, from: ItemKey, to: ItemKey): void {
  if (from.source === 'home') return;
  db.transaction(() => {
    db.prepare(`DELETE FROM comments WHERE ${UNDER}`).run({ owner: to.owner, source: to.source, p: to.path });
    db.prepare(`UPDATE comments SET path = @to || substr(path, length(@p) + 1) WHERE ${UNDER}`)
      .run({ owner: from.owner, source: from.source, p: from.path, to: to.path });
  }).immediate();
}

/**
 * Items were deleted through the app in a source other than the owner's home (into the provider's trash, which Files
 * cannot restore from): their threads and those beneath them are deleted.
 */
export function deleteComments(db: Db, keys: readonly ItemKey[]): void {
  db.transaction(() => {
    const stmt = db.prepare(`DELETE FROM comments WHERE ${UNDER}`);
    for (const k of keys) if (k.source !== 'home') stmt.run({ owner: k.owner, source: k.source, p: k.path });
  }).immediate();
}
