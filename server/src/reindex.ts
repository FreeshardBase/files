// Rebuilds the name index from the homes on disk (#145): `node server/dist/reindex.js [userId…]` in the container,
// `pnpm --filter @files/server reindex [userId…]` in development. Without ids it rebuilds every member. It reads the same
// FILES_* environment as the server and, started as root (`docker exec`), drops to the runtime user first, so the
// database never gains root-owned files. A write that lands while a home is being walked may be missed; run it again or
// while the app is stopped. Exits 1 on bad config or data dir; any other error is thrown and exits non-zero too.
import { loadConfig, ConfigError } from './config.ts';
import { openDb } from './db.ts';
import { dbPath } from './paths.ts';
import { assertDataDirWritable, DataDirError, dropPrivileges, RUNTIME_USER } from './dataDir.ts';
import { rebuildNameIndexes } from './storage/reindex.ts';

async function run(ids: string[]): Promise<number> {
  let config;
  try {
    config = loadConfig(process.env);
    if (process.getuid!() === 0) dropPrivileges(RUNTIME_USER);
    assertDataDirWritable(config.dataDir);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof DataDirError) { console.error(err.message); return 1; }
    throw err;
  }
  const db = openDb(dbPath(config.dataDir));
  try {
    for (const r of await rebuildNameIndexes({ config, db }, ids.length ? ids : undefined)) console.log(`${r.userId}: ${r.items} items indexed`);
  } finally {
    db.close();
  }
  return 0;
}

process.exitCode = await run(process.argv.slice(2));
