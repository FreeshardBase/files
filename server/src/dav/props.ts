import type { Db } from '../db.ts';
import { AppError } from '../errors.ts';
import type { PropName } from './xml.ts';

// Dead properties (#157): what a client stores with PROPPATCH, one `dav_props` row per item and property, holding the
// property element as XML. The table is in PATH_TABLES, so rows follow moves and go with deletes in the same transaction.

export type DeadProp = PropName & { xml: string };

export function deadProps(db: Db, userId: string, path: string): DeadProp[] {
  return db.prepare('SELECT ns, name, xml FROM dav_props WHERE user_id = ? AND path = ? ORDER BY ns, name').all(userId, path) as DeadProp[];
}

export type PropChange = { op: 'set'; prop: DeadProp } | { op: 'remove'; prop: PropName };

// The rows sit in the shared database, outside the member's quota, so they are bounded (#254): one property's XML, the
// properties of one item, and what all of a member's rows take in the database (ROW_BYTES).
export const MAX_PROP_BYTES = 64 * 1024;
export const MAX_PROPS_PER_ITEM = 100;
export const MAX_PROP_BYTES_PER_MEMBER = 1024 * 1024;
export const ROW_OVERHEAD = 64;

// The item itself, or (`deep`) it and everything beneath it. substr instead of LIKE: `/a` never matches `/ab`.
const under = (deep: boolean) => deep ? `(path = @p OR substr(path, 1, length(@p) + 1) = @p || '/')` : 'path = @p';
// What a row takes: the UTF-8 bytes of its XML, its key twice (the table and the primary key index; a long path with an
// empty property costs as much as its path) and a fixed overhead. Text is stored as UTF-8; length() would count characters.
const bytes = (col: string) => `length(CAST(${col} AS BLOB))`;
const ROW_BYTES = `${bytes('xml')} + 2 * (${bytes('path')} + ${bytes('ns')} + ${bytes('name')}) + ${ROW_OVERHEAD}`;
const memberBytes = (db: Db, userId: string) =>
  db.prepare(`SELECT COALESCE(SUM(${ROW_BYTES}), 0) FROM dav_props WHERE user_id = ?`).pluck().get(userId) as number;
const bytesUnder = (db: Db, userId: string, path: string, deep: boolean) => db.prepare(
  `SELECT COALESCE(SUM(${ROW_BYTES}), 0) FROM dav_props WHERE user_id = @u AND ${under(deep)}`).pluck().get({ u: userId, p: path }) as number;
const itemCount = (db: Db, userId: string, path: string) =>
  db.prepare('SELECT COUNT(*) FROM dav_props WHERE user_id = ? AND path = ?').pluck().get(userId, path) as number;

export const tooLarge = (prop: DeadProp) => Buffer.byteLength(prop.xml) > MAX_PROP_BYTES;

// Thrown inside the transaction to roll back a PROPPATCH that would break a bound.
class OverBound extends Error {}

/**
 * Applies a PROPPATCH's instructions in document order, all in one transaction. Answers false and changes nothing when a
 * property is larger than MAX_PROP_BYTES, or when the result has more properties on the item or more bytes for the member
 * than allowed and more than before: a change that does not grow them (a removal, a smaller value) always goes through.
 */
export function changeProps(db: Db, userId: string, path: string, changes: readonly PropChange[]): boolean {
  if (changes.some((c) => c.op === 'set' && tooLarge(c.prop))) return false;
  const set = db.prepare('INSERT OR REPLACE INTO dav_props (user_id, path, ns, name, xml) VALUES (?, ?, ?, ?, ?)');
  const remove = db.prepare('DELETE FROM dav_props WHERE user_id = ? AND path = ? AND ns = ? AND name = ?');
  try {
    db.transaction(() => {
      const before = { count: itemCount(db, userId, path), bytes: memberBytes(db, userId) };
      for (const c of changes) {
        if (c.op === 'set') set.run(userId, path, c.prop.ns, c.prop.name, c.prop.xml);
        else remove.run(userId, path, c.prop.ns, c.prop.name);
      }
      const count = itemCount(db, userId, path);
      const total = memberBytes(db, userId);
      if ((count > MAX_PROPS_PER_ITEM && count > before.count) || (total > MAX_PROP_BYTES_PER_MEMBER && total > before.bytes)) {
        throw new OverBound();
      }
    }).immediate();
  } catch (e) { // handled: OverBound rolled the changes back and the caller answers 507; any other error rethrows
    if (e instanceof OverBound) return false;
    throw e;
  }
  return true;
}

/**
 * QUOTA_EXCEEDED when copying the properties at `from` (`deep`: and beneath it) to `to` would take the member past
 * MAX_PROP_BYTES_PER_MEMBER. Everything at and beneath the target gives way to the copy (a replaced item goes to the
 * trash whole), so its properties do not count; the copies' rows carry the target's path instead of the source's.
 */
export function checkCopyFits(db: Db, userId: string, from: string, to: string, deep: boolean): void {
  const rows = db.prepare(`SELECT COUNT(*) FROM dav_props WHERE user_id = @u AND ${under(deep)}`).pluck().get({ u: userId, p: from }) as number;
  const added = bytesUnder(db, userId, from, deep) + 2 * rows * (Buffer.byteLength(to) - Buffer.byteLength(from));
  if (rows > 0 && memberBytes(db, userId) - bytesUnder(db, userId, to, true) + added > MAX_PROP_BYTES_PER_MEMBER) {
    throw new AppError('QUOTA_EXCEEDED');
  }
}

/**
 * A COPY placed `from` at `to`: the copy gets the source's properties (`deep`: those of everything beneath it too). Rows
 * left at the target by an item the copy replaced went to the trash with it; any others there are stale and give way.
 */
export function copyProps(db: Db, userId: string, from: string, to: string, deep: boolean): void {
  db.transaction(() => {
    // Checked again here: a PROPPATCH may have run while the bytes were copied.
    checkCopyFits(db, userId, from, to, deep);
    db.prepare(`DELETE FROM dav_props WHERE user_id = @u AND ${under(deep)}`).run({ u: userId, p: to });
    db.prepare(`INSERT INTO dav_props (user_id, path, ns, name, xml)
      SELECT user_id, @to || substr(path, length(@p) + 1), ns, name, xml FROM dav_props WHERE user_id = @u AND ${under(deep)}`)
      .run({ u: userId, p: from, to });
  }).immediate();
}
