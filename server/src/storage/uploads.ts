import type { FastifyBaseLogger } from 'fastify';
import { homeRoot } from '../paths.ts';
import { every } from '../schedule.ts';
import { LocalBackend } from './local.ts';
import type { TrashDeps } from './trash.ts';

export type UploadExpiryResult = { removed: string[]; failed: string[] };

/**
 * Removes every resumable upload that has had no bytes for `UPLOAD_TTL_MS` (its `Upload-Expires` has passed), with its
 * staged bytes, through `LocalBackend.expireUploads`. One that is receiving bytes right now is left for the next run.
 */
export async function expireUploads(deps: TrashDeps, log: FastifyBaseLogger, now = new Date()): Promise<UploadExpiryResult> {
  const users = deps.db.prepare('SELECT DISTINCT user_id FROM uploads WHERE expires_at < ?').pluck().all(now.toISOString()) as string[];
  const result: UploadExpiryResult = { removed: [], failed: [] };
  for (const userId of users) {
    const home = new LocalBackend(homeRoot(deps.config.dataDir, userId),
      { db: deps.db, userId, pathTables: deps.pathTables, trashTables: deps.trashTables, versions: deps.config.versions,
        etagKey: deps.config.etagKey });
    const r = await home.expireUploads(now, log);
    result.removed.push(...r.removed); result.failed.push(...r.failed);
  }
  if (users.length > 0) log.info({ removed: result.removed.length, failed: result.failed.length }, 'upload expiry finished');
  return result;
}

/** Runs `expireUploads` right away and then every `intervalMs`; `stop` waits for a run in flight. */
export function scheduleUploadExpiry(deps: TrashDeps, log: FastifyBaseLogger, intervalMs = 3600_000): { stop(): Promise<void> } {
  return every(intervalMs, () => expireUploads(deps, log), (e) => { log.error({ err: e }, 'upload expiry failed'); });
}
