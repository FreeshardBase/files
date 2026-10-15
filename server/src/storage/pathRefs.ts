import type { Db } from '../db.ts';

/**
 * A table whose rows point at a path in a member's home (shares, favourites, search index, versions, …).
 * A move rewrites the rows of the item and everything beneath it; a delete removes them. Both run in the same
 * transaction as the filesystem step (spec §3.6), so no row ever points at a path that is gone.
 *
 * `sourceColumn`: the table also holds rows for other sources (a share of a cloud file); only rows whose column is
 * `home` are home paths and cascade. `orphanColumn`: a delete sets this column to the time instead of removing the row,
 * so the row can answer "gone" (a share's 410); an orphaned row never moves again and is never orphaned twice.
 * `trashColumn`: the rows go to the trash with their item: a delete to the trash sets this column to the trash id
 * instead of removing the row (the table is then also in `TRASH_TABLES`, which brings the rows back on restore and
 * purges them with the item). Such rows stand for bytes on disk, so a delete that names no trash item leaves them.
 */
export type PathTable = { table: string; ownerColumn: string; pathColumn: string; sourceColumn?: string; orphanColumn?: string;
  trashColumn?: string };

/** Every path-dependent table that exists. Each issue that adds one appends it here and extends the cascade test. */
export const PATH_TABLES: readonly PathTable[] = [
  { table: 'recent', ownerColumn: 'user_id', pathColumn: 'path' }, // #141, asserted in server/test/recent.test.ts
  { table: 'name_index', ownerColumn: 'user_id', pathColumn: 'path' }, // #145, asserted in server/test/search.test.ts
  // #146, asserted in server/test/shares.test.ts
  { table: 'shares', ownerColumn: 'owner_id', pathColumn: 'path', sourceColumn: 'source', orphanColumn: 'orphaned_at' },
  // #147, asserted in server/test/publicLinks.test.ts
  { table: 'public_links', ownerColumn: 'owner_id', pathColumn: 'path', sourceColumn: 'source', orphanColumn: 'orphaned_at' },
  // #154, asserted in server/test/versions.test.ts
  { table: 'versions', ownerColumn: 'user_id', pathColumn: 'path', trashColumn: 'trash_id' },
];

const IDENT = /^[a-z_][a-z0-9_]*$/;
function checked(t: PathTable): PathTable {
  const names = [t.table, t.ownerColumn, t.pathColumn, ...[t.sourceColumn, t.orphanColumn, t.trashColumn].filter((c) => c !== undefined)];
  if (!names.every((s) => IDENT.test(s))) throw new Error(`invalid path table ${JSON.stringify(t)}`);
  return t;
}

// The item itself or anything beneath it. substr instead of LIKE: no wildcard escaping, and `/a` never matches `/ab`.
const under = (path: string) => `(${path} = @p OR substr(${path}, 1, length(@p) + 1) = @p || '/')`;
// The owner's live rows of the home at or beneath @p.
const rowsUnder = (t: PathTable) => `${t.ownerColumn} = @owner AND ${under(t.pathColumn)}`
  + (t.sourceColumn ? ` AND ${t.sourceColumn} = 'home'` : '') + (t.orphanColumn ? ` AND ${t.orphanColumn} IS NULL` : '')
  + (t.trashColumn ? ` AND ${t.trashColumn} IS NULL` : '');

export function movePathRefs(db: Db, tables: readonly PathTable[], owner: string, from: string, to: string): void {
  for (const t of tables.map(checked)) {
    db.prepare(`UPDATE ${t.table} SET ${t.pathColumn} = @to || substr(${t.pathColumn}, length(@p) + 1)
      WHERE ${rowsUnder(t)}`).run({ owner, p: from, to });
  }
}

/**
 * A table whose rows hang off one trash row (versions kept with a trashed file). Purging the item deletes them in the
 * same transaction as the trash row. `pathColumn`: restore brings the rows back (column cleared) at the path the item
 * is restored to; without it restore does not touch them. An issue that adds such a table decides what restore does with
 * its rows and extends `server/test/trash.test.ts`.
 */
export type TrashTable = { table: string; column: string; pathColumn?: string };

/** Every table that hangs off a trash row. */
export const TRASH_TABLES: readonly TrashTable[] = [
  { table: 'versions', column: 'trash_id', pathColumn: 'path' }, // #154, asserted in server/test/versions.test.ts
];

const checkedTrash = (t: TrashTable): TrashTable => {
  if (![t.table, t.column, ...(t.pathColumn ? [t.pathColumn] : [])].every((s) => IDENT.test(s))) {
    throw new Error(`invalid trash table ${JSON.stringify(t)}`);
  }
  return t;
};

export function deleteTrashRefs(db: Db, tables: readonly TrashTable[], trashId: string): void {
  for (const t of tables.map(checkedTrash)) db.prepare(`DELETE FROM ${t.table} WHERE ${t.column} = ?`).run(trashId);
}

/** The trash item `trashId`, trashed from `from`, is back at `to`: rows that come back with it are live again there. */
export function restoreTrashRefs(db: Db, tables: readonly TrashTable[], trashId: string, from: string, to: string): void {
  for (const t of tables.map(checkedTrash)) {
    if (!t.pathColumn) continue;
    db.prepare(`UPDATE ${t.table} SET ${t.column} = NULL, ${t.pathColumn} = @to || substr(${t.pathColumn}, length(@from) + 1)
      WHERE ${t.column} = @trash`).run({ trash: trashId, from, to });
  }
}

/**
 * A whole source of the owner is gone (an unlinked connection, #148): rows of tables that hold other sources than the
 * home (`sourceColumn`) are orphaned where the table has an `orphanColumn`, else removed. Runs in the caller's transaction.
 */
export function orphanSourceRefs(db: Db, tables: readonly PathTable[], owner: string, source: string): void {
  for (const t of tables.map(checked)) {
    if (!t.sourceColumn) continue;
    if (t.orphanColumn) {
      db.prepare(`UPDATE ${t.table} SET ${t.orphanColumn} = @now WHERE ${t.ownerColumn} = @owner AND ${t.sourceColumn} = @source
        AND ${t.orphanColumn} IS NULL`).run({ owner, source, now: new Date().toISOString() });
    } else {
      db.prepare(`DELETE FROM ${t.table} WHERE ${t.ownerColumn} = @owner AND ${t.sourceColumn} = @source`).run({ owner, source });
    }
  }
}

/**
 * The item at `path` is gone. With `trashId` it went to the trash as that item, and tables with a `trashColumn` hand
 * their rows to it; without one (rows left by a change outside the app) those tables keep their rows.
 */
export function deletePathRefs(db: Db, tables: readonly PathTable[], owner: string, path: string, trashId?: string): void {
  for (const t of tables.map(checked)) {
    if (t.trashColumn) {
      if (trashId !== undefined) db.prepare(`UPDATE ${t.table} SET ${t.trashColumn} = @trash WHERE ${rowsUnder(t)}`).run({ owner, p: path, trash: trashId });
    } else if (t.orphanColumn) {
      db.prepare(`UPDATE ${t.table} SET ${t.orphanColumn} = @now WHERE ${rowsUnder(t)}`).run({ owner, p: path, now: new Date().toISOString() });
    } else {
      db.prepare(`DELETE FROM ${t.table} WHERE ${rowsUnder(t)}`).run({ owner, p: path });
    }
  }
}
