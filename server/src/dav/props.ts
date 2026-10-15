import type { Db } from '../db.ts';
import type { PropName } from './xml.ts';

// Dead properties (#157): what a client stores with PROPPATCH, one `dav_props` row per item and property, holding the
// property element as XML. The table is in PATH_TABLES, so rows follow moves and go with deletes in the same transaction.

export type DeadProp = PropName & { xml: string };

export function deadProps(db: Db, userId: string, path: string): DeadProp[] {
  return db.prepare('SELECT ns, name, xml FROM dav_props WHERE user_id = ? AND path = ? ORDER BY ns, name').all(userId, path) as DeadProp[];
}

export type PropChange = { op: 'set'; prop: DeadProp } | { op: 'remove'; prop: PropName };

/** Applies a PROPPATCH's instructions in document order, all in one transaction. */
export function changeProps(db: Db, userId: string, path: string, changes: readonly PropChange[]): void {
  const set = db.prepare('INSERT OR REPLACE INTO dav_props (user_id, path, ns, name, xml) VALUES (?, ?, ?, ?, ?)');
  const remove = db.prepare('DELETE FROM dav_props WHERE user_id = ? AND path = ? AND ns = ? AND name = ?');
  db.transaction(() => {
    for (const c of changes) {
      if (c.op === 'set') set.run(userId, path, c.prop.ns, c.prop.name, c.prop.xml);
      else remove.run(userId, path, c.prop.ns, c.prop.name);
    }
  }).immediate();
}

/**
 * A COPY placed `from` at `to`: the copy gets the source's properties (`deep`: those of everything beneath it too). Rows
 * left at the target by an item the copy replaced went to the trash with it; any others there are stale and give way.
 */
export function copyProps(db: Db, userId: string, from: string, to: string, deep: boolean): void {
  const under = (col: string) => deep ? `(${col} = @p OR substr(${col}, 1, length(@p) + 1) = @p || '/')` : `${col} = @p`;
  db.transaction(() => {
    db.prepare(`DELETE FROM dav_props WHERE user_id = @u AND ${under('path')}`).run({ u: userId, p: to });
    db.prepare(`INSERT INTO dav_props (user_id, path, ns, name, xml)
      SELECT user_id, @to || substr(path, length(@p) + 1), ns, name, xml FROM dav_props WHERE user_id = @u AND ${under('path')}`)
      .run({ u: userId, p: from, to });
  }).immediate();
}
