import type { Db } from '../db.ts';

/**
 * A table whose rows point at a path in a member's home (shares, favourites, search index, versions, …).
 * A move rewrites the rows of the item and everything beneath it; a delete removes them. Both run in the same
 * transaction as the filesystem step (spec §3.6), so no row ever points at a path that is gone.
 */
export type PathTable = { table: string; ownerColumn: string; pathColumn: string };

/** Every path-dependent table that exists. Each issue that adds one appends it here and extends the cascade test. */
export const PATH_TABLES: readonly PathTable[] = [
  { table: 'recent', ownerColumn: 'user_id', pathColumn: 'path' }, // #141, asserted in server/test/recent.test.ts
  { table: 'name_index', ownerColumn: 'user_id', pathColumn: 'path' }, // #145, asserted in server/test/search.test.ts
];

const IDENT = /^[a-z_][a-z0-9_]*$/;
function checked(t: PathTable): PathTable {
  if (![t.table, t.ownerColumn, t.pathColumn].every((s) => IDENT.test(s))) throw new Error(`invalid path table ${JSON.stringify(t)}`);
  return t;
}

// The item itself or anything beneath it. substr instead of LIKE: no wildcard escaping, and `/a` never matches `/ab`.
const under = (path: string) => `(${path} = @p OR substr(${path}, 1, length(@p) + 1) = @p || '/')`;

export function movePathRefs(db: Db, tables: readonly PathTable[], owner: string, from: string, to: string): void {
  for (const t of tables.map(checked)) {
    db.prepare(`UPDATE ${t.table} SET ${t.pathColumn} = @to || substr(${t.pathColumn}, length(@p) + 1)
      WHERE ${t.ownerColumn} = @owner AND ${under(t.pathColumn)}`).run({ owner, p: from, to });
  }
}

/**
 * A table whose rows hang off one trash row (later: versions kept with a trashed file). Purging the item deletes them in
 * the same transaction as the trash row. Restore does not touch them: an issue that adds such a table also decides what
 * restore does with its rows and extends `server/test/trash.test.ts`.
 */
export type TrashTable = { table: string; column: string };

/** Every table that hangs off a trash row. None exists yet. */
export const TRASH_TABLES: readonly TrashTable[] = [];

export function deleteTrashRefs(db: Db, tables: readonly TrashTable[], trashId: string): void {
  for (const t of tables) {
    if (![t.table, t.column].every((s) => IDENT.test(s))) throw new Error(`invalid trash table ${JSON.stringify(t)}`);
    db.prepare(`DELETE FROM ${t.table} WHERE ${t.column} = ?`).run(trashId);
  }
}

export function deletePathRefs(db: Db, tables: readonly PathTable[], owner: string, path: string): void {
  for (const t of tables.map(checked)) {
    db.prepare(`DELETE FROM ${t.table} WHERE ${t.ownerColumn} = @owner AND ${under(t.pathColumn)}`).run({ owner, p: path });
  }
}
