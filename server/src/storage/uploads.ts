import type { FastifyBaseLogger } from 'fastify';
import { homeRoot } from '../paths.ts';
import { every } from '../schedule.ts';
import { closedWithOpenUploads, discardOpenUploads } from './fileRequests.ts';
import { LocalBackend } from './local.ts';
import type { TrashDeps } from './trash.ts';

export type UploadExpiryResult = { removed: string[]; failed: string[] };

/**
 * Removes every resumable upload that has had no bytes for `UPLOAD_TTL_MS` (its `Upload-Expires` has passed), with its
 * staged bytes, through `LocalBackend.expireUploads`, and every open upload of a file request that is no longer live.
 * One that is receiving bytes right now is left for the next run.
 */
export async function expireUploads(deps: TrashDeps, log: FastifyBaseLogger, now = new Date()): Promise<UploadExpiryResult> {
  const homeOf = (userId: string) => new LocalBackend(homeRoot(deps.config.dataDir, userId),
    { db: deps.db, userId, pathTables: deps.pathTables, trashTables: deps.trashTables, versions: deps.config.versions,
      etagKey: deps.config.etagKey });
  const result: UploadExpiryResult = { removed: [], failed: [] };
  // A file request that is no longer live (revoked, orphaned, expired) keeps none of its visitors' open uploads (#304).
  const closed = closedWithOpenUploads(deps.db, now);
  for (const r of closed) {
    try { result.removed.push(...(await discardOpenUploads(deps.db, homeOf(r.owner_id), r.id)).removed); }
    catch (e) { // handled: logged with the request id; its uploads stay for the next run or their own expiry
      log.error({ err: e, request: r.id, userId: r.owner_id }, 'upload expiry could not discard a closed file request\'s uploads');
    }
  }
  const users = deps.db.prepare('SELECT DISTINCT user_id FROM uploads WHERE expires_at < ?').pluck().all(now.toISOString()) as string[];
  for (const userId of users) {
    const r = await homeOf(userId).expireUploads(now, log);
    result.removed.push(...r.removed); result.failed.push(...r.failed);
  }
  if (users.length > 0 || closed.length > 0) log.info({ removed: result.removed.length, failed: result.failed.length }, 'upload expiry finished');
  return result;
}

/** Runs `expireUploads` right away and then every `intervalMs`; `stop` waits for a run in flight. */
export function scheduleUploadExpiry(deps: TrashDeps, log: FastifyBaseLogger, intervalMs = 3600_000): { stop(): Promise<void> } {
  return every(intervalMs, () => expireUploads(deps, log), (e) => { log.error({ err: e }, 'upload expiry failed'); });
}
