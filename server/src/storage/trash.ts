import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.ts';
import type { Db } from '../db.ts';
import { homeRoot } from '../paths.ts';
import { LocalBackend } from './local.ts';
import type { PathTable, TrashTable } from './pathRefs.ts';

export type TrashDeps = { config: Config; db: Db; pathTables: readonly PathTable[]; trashTables: readonly TrashTable[] };
export type ExpiryResult = { purged: string[]; failed: string[] };

const DAY_MS = 86_400_000;

/**
 * Permanently deletes every item that has been in a trash longer than the retention period, through the same
 * `LocalBackend.purge` as a single delete and "empty trash". An item whose bytes cannot be removed keeps its row and is
 * reported in `failed` (purge logs it); the next run tries again.
 */
export async function expireTrash(deps: TrashDeps, log: FastifyBaseLogger, now = new Date()): Promise<ExpiryResult> {
  const cutoff = new Date(now.getTime() - deps.config.trashRetentionDays * DAY_MS).toISOString();
  const rows = deps.db.prepare('SELECT user_id, id FROM trash WHERE deleted_at < ?').all(cutoff) as { user_id: string; id: string }[];
  const result: ExpiryResult = { purged: [], failed: [] };
  for (const [userId, items] of Map.groupBy(rows, (r) => r.user_id)) {
    const home = new LocalBackend(homeRoot(deps.config.dataDir, userId),
      { db: deps.db, userId, pathTables: deps.pathTables, trashTables: deps.trashTables });
    // Read before this member's lock: an item restored or purged meanwhile is skipped, not an error.
    const r = await home.purge(items.map((i) => i.id), log, 'skip');
    result.purged.push(...r.purged); result.failed.push(...r.failed);
  }
  if (rows.length > 0) log.info({ purged: result.purged.length, failed: result.failed.length }, 'trash expiry finished');
  return result;
}

/** Runs `expireTrash` right away and then every `intervalMs`; `stop` waits for a run in flight. */
export function scheduleTrashExpiry(deps: TrashDeps, log: FastifyBaseLogger, intervalMs = 3600_000): { stop(): Promise<void> } {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return; // the previous run is still going; the next tick tries again
    running = expireTrash(deps, log)
      .then(() => undefined, (e: unknown) => { log.error({ err: e }, 'trash expiry failed'); }) // handled: logged; the next tick retries
      .finally(() => { running = null; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return { async stop() { clearInterval(timer); await running; } };
}
