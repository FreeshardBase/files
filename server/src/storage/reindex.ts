import type { Config } from '../config.ts';
import type { Db } from '../db.ts';
import { homeRoot } from '../paths.ts';
import { LocalBackend } from './local.ts';
import { PATH_TABLES, TRASH_TABLES } from './pathRefs.ts';

/**
 * Rebuilds the name index (#145) of the given members, or of every member, from what is on disk. The recovery path
 * after files were changed outside the app or the index was lost; `server/src/reindex.ts` is its command.
 */
export async function rebuildNameIndexes(deps: { config: Config; db: Db }, userIds?: readonly string[]):
  Promise<{ userId: string; items: number }[]> {
  const { config, db } = deps;
  const ids = userIds ?? db.prepare('SELECT id FROM users ORDER BY id').pluck().all() as string[];
  const out: { userId: string; items: number }[] = [];
  for (const userId of ids) {
    if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId) === undefined) throw new Error(`no member with id ${userId}`);
    const home = new LocalBackend(homeRoot(config.dataDir, userId), { db, userId, pathTables: PATH_TABLES, trashTables: TRASH_TABLES,
      versions: config.versions, etagKey: config.etagKey });
    out.push({ userId, items: await home.rebuildNameIndex() });
  }
  return out;
}
