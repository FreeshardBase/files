import type { Db } from '../db.ts';

/**
 * A table whose rows point at a path in a member's home (shares, favourites, search index, versions, …).
 * A move rewrites the rows of the item and everything beneath it; a delete removes them. Both run in the same
 * transaction as the filesystem step (spec §3.6), so no row ever points at a path that is gone.
 */
export type PathTable = { table: string; ownerColumn: string; pathColumn: string };

/** Every path-dependent table that exists. Each issue that adds one appends it here and extends the cascade test. */
export const PATH_TABLES: readonly PathTable[] = [];

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

export function deletePathRefs(db: Db, tables: readonly PathTable[], owner: string, path: string): void {
  for (const t of tables.map(checked)) {
    db.prepare(`DELETE FROM ${t.table} WHERE ${t.ownerColumn} = @owner AND ${under(t.pathColumn)}`).run({ owner, p: path });
  }
}
