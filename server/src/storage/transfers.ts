import { createHash, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { pipeline, Transform } from 'node:stream';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { CollisionPolicy, CreateTransferRequest, ErrorCode, TransferJob, TransferStatus } from '@files/shared';
import { AppError } from '../errors.ts';
import { getUser } from '../users.ts';
import type { StorageBackend } from './backend.ts';
import { normalizeUserPath } from './resolveInRoot.ts';
import { sourceFor, type ResolvedSource } from './resolveSource.ts';

/** Items copied at once, over all jobs of all members: enough to overlap round trips, few enough for provider limits. */
export const TRANSFER_CONCURRENCY = 2;
/** Progress events per job at most this often while bytes flow; every state change is sent at once. */
const PROGRESS_MS = 250;
/** A transfer is not an upload: the member's quota limits what lands in the home, not the upload size limit. */
const MAX_BYTES = Number.MAX_SAFE_INTEGER;
/** Jobs a member sees in the panel, newest first. */
const LIST_LIMIT = 50;

type Deps = FastifyInstance['deps'];
type JobRow = { id: string; user_id: string; mode: 'copy' | 'move'; from_source: string; to_source: string; dir: string;
  status: TransferStatus; created_at: string; finished_at: string | null };
type ItemRow = { job_id: string; seq: number; parent: number | null; from_path: string; to_path: string;
  on_collision: CollisionPolicy; type: 'file' | 'directory' | null; placed: string | null; status: string; error: string | null; bytes: number };
/** Why an item's work was aborted: the member cancelled the job, or the app is shutting down (the item resumes later). */
type AbortReason = 'cancel' | 'stop';

const isNotFound = (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND';
async function statOrNull(b: StorageBackend, path: string) {
  return b.stat(path).then((e) => e, (e: unknown) => { if (isNotFound(e)) return null; throw e; }); // handled: absent is null
}

/**
 * Copies and moves between sources as persistent jobs (spec §3.4, #152). A job row and one row per item live in SQLite;
 * workers run in this process, at most TRANSFER_CONCURRENCY items at a time. A file item is done only after the target
 * holds exactly the bytes sent: its size, and its SHA-256 where a side offers `digest`. A folder item is done once its
 * target folder exists and its children are items of the job. A move deletes the source of done items when the job
 * ends (whole folders where everything beneath them is done), so a failed item always keeps its source. Jobs still
 * running at start-up resume: items in flight start again, done ones are never redone.
 */
export class TransferEngine {
  private active = new Map<string, { jobId: string; ctl: AbortController; promise: Promise<void> }>();
  private inflight = new Map<string, number>();
  private lastProgress = new Map<string, number>();
  private finishing = new Map<string, Promise<void>>();
  private listeners = new Map<string, Set<(job: TransferJob) => void>>();
  private stopping = false;

  constructor(private deps: Deps, private log: FastifyBaseLogger) {}

  /** At start-up: work a previous process had in flight starts again; jobs whose items are all settled are finished. */
  start(): void {
    const { db } = this.deps;
    db.prepare(`UPDATE transfer_items SET status = 'pending' WHERE status = 'active'`).run();
    const running = db.prepare(`SELECT id FROM transfer_jobs WHERE status = 'running'`).pluck().all() as string[];
    if (running.length) this.log.info({ jobs: running.length }, 'resuming transfer jobs');
    for (const id of running) this.settle(id);
    this.pump();
  }

  /** Aborts the items in flight without recording them (they resume at the next start) and waits for them. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const a of this.active.values()) a.ctl.abort('stop' satisfies AbortReason);
    await Promise.all([...this.active.values()].map((a) => a.promise));
    await Promise.all(this.finishing.values());
    this.listeners.clear();
  }

  async create(userId: string, req: CreateTransferRequest): Promise<TransferJob> {
    const user = getUser(this.deps.db, userId);
    if (!user) throw new AppError('UNAUTHENTICATED');
    // Within one source the direct move and copy routes apply; a job is for crossing sources.
    if (req.from === req.to) throw new AppError('VALIDATION');
    const from = await sourceFor(this.deps, user, req.from);
    if (req.mode === 'move' && from.access !== 'edit') throw new AppError('FORBIDDEN');
    const to = await sourceFor(this.deps, user, req.to);
    if (to.access !== 'edit') throw new AppError('FORBIDDEN');
    const dir = normalizeUserPath(req.dir);
    if ((await to.backend.stat(dir)).type !== 'directory') throw new AppError('NOT_A_DIRECTORY');
    const items = req.items.map((i) => ({ from: normalizeUserPath(i.path), onCollision: i.onCollision }));
    // The root of a source has no name to land under.
    if (items.some((i) => i.from === '/')) throw new AppError('VALIDATION');
    const id = randomBytes(16).toString('hex');
    const { db } = this.deps;
    db.transaction(() => {
      db.prepare(`INSERT INTO transfer_jobs (id, user_id, mode, from_source, to_source, dir, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`).run(id, user.id, req.mode, req.from, req.to, dir, new Date().toISOString());
      const insert = db.prepare(`INSERT INTO transfer_items (job_id, seq, from_path, to_path, on_collision, status)
        VALUES (?, ?, ?, ?, ?, 'pending')`);
      items.forEach((i, seq) => insert.run(id, seq, i.from, posix.join(dir, posix.basename(i.from)), i.onCollision));
    }).immediate();
    this.emit(id);
    this.pump();
    return this.view(id);
  }

  /** The member's own job, or NOT_FOUND: another member's job does not exist for them. */
  get(userId: string, id: string): TransferJob {
    this.own(userId, id);
    return this.view(id);
  }

  list(userId: string): TransferJob[] {
    const ids = this.deps.db.prepare(`SELECT id FROM transfer_jobs WHERE user_id = ? ORDER BY created_at DESC, id LIMIT ?`)
      .pluck().all(userId, LIST_LIMIT) as string[];
    return ids.map((id) => this.view(id));
  }

  /** No new item starts; items in flight are aborted and leave nothing behind. Done items stay done. */
  cancel(userId: string, id: string): TransferJob {
    const job = this.own(userId, id);
    if (job.status !== 'running') return this.view(id);
    const { db } = this.deps;
    db.transaction(() => {
      db.prepare(`UPDATE transfer_jobs SET status = 'cancelled', finished_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
      db.prepare(`UPDATE transfer_items SET status = 'cancelled' WHERE job_id = ? AND status = 'pending'`).run(id);
    }).immediate();
    for (const a of this.active.values()) if (a.jobId === id) a.ctl.abort('cancel' satisfies AbortReason);
    this.emit(id);
    this.settle(id);
    return this.view(id);
  }

  /** Removes the member's finished jobs from the list. */
  clearFinished(userId: string): void {
    this.deps.db.prepare(`DELETE FROM transfer_jobs WHERE user_id = ? AND status != 'running'`).run(userId);
  }

  /** Every state change and progress of the member's own jobs; returns the unsubscribe. */
  subscribe(userId: string, fn: (job: TransferJob) => void): () => void {
    const set = this.listeners.get(userId) ?? new Set();
    set.add(fn);
    this.listeners.set(userId, set);
    return () => { set.delete(fn); if (!set.size) this.listeners.delete(userId); };
  }

  private own(userId: string, id: string): JobRow {
    const job = this.deps.db.prepare(`SELECT * FROM transfer_jobs WHERE id = ? AND user_id = ?`).get(id, userId) as JobRow | undefined;
    if (!job) throw new AppError('NOT_FOUND');
    return job;
  }

  private view(id: string): TransferJob {
    const { db } = this.deps;
    const job = db.prepare(`SELECT * FROM transfer_jobs WHERE id = ?`).get(id) as JobRow;
    const counts = Object.fromEntries((db.prepare(`SELECT status, count(*) AS n FROM transfer_items WHERE job_id = ? GROUP BY status`)
      .all(id) as { status: string; n: number }[]).map((r) => [r.status, r.n]));
    const failed = (db.prepare(`SELECT from_path, error FROM transfer_items WHERE job_id = ? AND status = 'failed' ORDER BY seq`)
      .all(id) as { from_path: string; error: ErrorCode }[]).map((r) => ({ path: r.from_path, code: r.error }));
    const doneBytes = db.prepare(`SELECT coalesce(sum(bytes), 0) FROM transfer_items WHERE job_id = ? AND status = 'done'`).pluck().get(id) as number;
    let flowing = 0;
    for (const [key, n] of this.inflight) if (key.startsWith(`${id}:`)) flowing += n;
    const first = db.prepare(`SELECT from_path FROM transfer_items WHERE job_id = ? ORDER BY seq LIMIT 1`).pluck().get(id) as string;
    return { id, mode: job.mode, from: job.from_source, to: job.to_source, dir: job.dir, name: posix.basename(first),
      status: job.status, total: Object.values(counts).reduce((a, b) => a + b, 0), done: counts.done ?? 0,
      cancelled: counts.cancelled ?? 0, failed, bytes: doneBytes + flowing, createdAt: job.created_at, finishedAt: job.finished_at };
  }

  private emit(id: string): void {
    const userId = this.deps.db.prepare(`SELECT user_id FROM transfer_jobs WHERE id = ?`).pluck().get(id) as string | undefined;
    const set = userId ? this.listeners.get(userId) : undefined;
    if (!set?.size) return;
    const job = this.view(id);
    for (const fn of set) fn(job);
  }

  private progress(key: string, jobId: string, bytes: number): void {
    this.inflight.set(key, bytes);
    const now = Date.now();
    if (now - (this.lastProgress.get(jobId) ?? 0) < PROGRESS_MS) return;
    this.lastProgress.set(jobId, now);
    this.emit(jobId);
  }

  // Starts pending items of running jobs, oldest job first, until the concurrency is used.
  private pump(): void {
    const { db } = this.deps;
    while (!this.stopping && this.active.size < TRANSFER_CONCURRENCY) {
      const next = db.prepare(`SELECT i.job_id AS jobId, i.seq FROM transfer_items i JOIN transfer_jobs j ON j.id = i.job_id
        WHERE i.status = 'pending' AND j.status = 'running' ORDER BY j.created_at, j.id, i.seq LIMIT 1`).get() as { jobId: string; seq: number } | undefined;
      if (!next) return;
      db.prepare(`UPDATE transfer_items SET status = 'active' WHERE job_id = ? AND seq = ?`).run(next.jobId, next.seq);
      const key = `${next.jobId}:${next.seq}`;
      const ctl = new AbortController();
      const promise = this.runItem(next.jobId, next.seq, ctl.signal)
        .catch((e: unknown) => { this.log.error({ err: e, job: next.jobId }, 'transfer item bookkeeping failed'); }) // handled: logged; the item stays active and resumes at the next start
        .finally(() => {
          this.active.delete(key); this.inflight.delete(key);
          if (this.stopping) return;
          this.emit(next.jobId);
          this.settle(next.jobId);
          this.pump();
        });
      this.active.set(key, { jobId: next.jobId, ctl, promise });
    }
  }

  private setItem(jobId: string, seq: number, fields: Partial<Pick<ItemRow, 'status' | 'error' | 'bytes' | 'placed' | 'type'>>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    this.deps.db.prepare(`UPDATE transfer_items SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE job_id = @jobId AND seq = @seq`)
      .run({ ...fields, jobId, seq });
  }

  private async runItem(jobId: string, seq: number, signal: AbortSignal): Promise<void> {
    const { db } = this.deps;
    const job = db.prepare(`SELECT * FROM transfer_jobs WHERE id = ?`).get(jobId) as JobRow;
    const item = db.prepare(`SELECT * FROM transfer_items WHERE job_id = ? AND seq = ?`).get(jobId, seq) as ItemRow;
    try {
      const { from, to } = await this.sources(job);
      const entry = await from.backend.stat(item.from_path);
      this.setItem(jobId, seq, { type: entry.type });
      if (entry.type === 'directory') await this.copyFolder(item, from.backend, to.backend);
      else this.setItem(jobId, seq, { status: 'done', error: null, bytes: await this.copyFile(item, from.backend, to.backend, signal) });
    } catch (e) {
      if (signal.aborted) {
        // A shutdown leaves the item active, so the next start runs it again; a cancel records it.
        if (signal.reason === ('cancel' satisfies AbortReason)) this.setItem(jobId, seq, { status: 'cancelled' });
        return;
      }
      if (!(e instanceof AppError)) this.log.error({ err: e, job: jobId }, 'transfer item failed');
      this.setItem(jobId, seq, { status: 'failed', error: e instanceof AppError ? e.code : 'INTERNAL' });
    }
  }

  // Resolved again for every item, with the job owner's current rights: an unlinked connection or a revoked share
  // fails the remaining items instead of reaching anything.
  private async sources(job: JobRow): Promise<{ from: ResolvedSource; to: ResolvedSource }> {
    const user = getUser(this.deps.db, job.user_id);
    if (!user) throw new AppError('SOURCE_NOT_FOUND');
    const from = await sourceFor(this.deps, user, job.from_source);
    const to = await sourceFor(this.deps, user, job.to_source);
    if (to.access !== 'edit' || (job.mode === 'move' && from.access !== 'edit')) throw new AppError('FORBIDDEN');
    return { from, to };
  }

  /** Streams one file and verifies the target; returns the verified size. */
  private async copyFile(item: ItemRow, from: StorageBackend, to: StorageBackend, signal: AbortSignal): Promise<number> {
    const key = `${item.job_id}:${item.seq}`;
    const src = await from.read(item.from_path);
    const hash = createHash('sha256');
    let sent = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        hash.update(chunk); sent += chunk.length;
        this.progress(key, item.job_id, sent);
        cb(null, chunk);
      },
    });
    // Aborting destroys what the target reads from, so its write fails and removes what it had staged.
    const abort = () => { meter.destroy(new Error(`transfer aborted: ${String(signal.reason)}`)); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    pipeline(src.stream, meter, () => undefined); // a failure on either side destroys meter, so the write below rejects with it
    // A resumed item whose bytes were placed before the restart replaces exactly that copy.
    const target = item.placed ?? item.to_path;
    let written;
    try {
      written = await to.write(target, meter, { onCollision: item.placed ? 'replace' : item.on_collision, maxBytes: MAX_BYTES,
        ...(src.unsized ? {} : { size: src.entry.size }) });
    } finally {
      signal.removeEventListener('abort', abort);
      src.stream.destroy();
    }
    this.setItem(item.job_id, item.seq, { placed: written.path });
    // Verification (#99): what was read must be what the source announced, and the target must hold exactly that.
    if (!src.unsized && sent !== src.entry.size) throw new AppError('SIZE_MISMATCH');
    const stored = await to.stat(written.path);
    if (stored.type !== 'file' || stored.size !== sent) throw new AppError('VERIFY_FAILED');
    const sum = hash.digest('hex');
    if (to.digest && await to.digest(written.path) !== sum) throw new AppError('VERIFY_FAILED');
    if (from.digest && await from.digest(item.from_path) !== sum) throw new AppError('VERIFY_FAILED');
    return sent;
  }

  /** Creates the target folder (its path fixed in the row first) and adds the folder's children as items. */
  private async copyFolder(item: ItemRow, from: StorageBackend, to: StorageBackend): Promise<void> {
    let placed = item.placed;
    if (!placed) {
      placed = await this.folderTarget(to, item.to_path, item.on_collision);
      this.setItem(item.job_id, item.seq, { placed });
    }
    const there = await statOrNull(to, placed);
    if (!there) await to.mkdir(placed);
    else if (there.type !== 'directory') throw new AppError('FILE_EXISTS', { name: posix.basename(placed) });
    const children: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await from.list(item.from_path, cursor);
      for (const e of page.entries) children.push(e.name);
      cursor = page.next;
    } while (cursor);
    const { db } = this.deps;
    db.transaction(() => {
      let seq = db.prepare(`SELECT max(seq) FROM transfer_items WHERE job_id = ?`).pluck().get(item.job_id) as number;
      // The folder is this job's own, so whatever lies in it came from this job (an earlier attempt): replace it.
      const insert = db.prepare(`INSERT INTO transfer_items (job_id, seq, parent, from_path, to_path, on_collision, status)
        VALUES (?, ?, ?, ?, ?, 'replace', 'pending')`);
      for (const name of children) insert.run(item.job_id, ++seq, item.seq, posix.join(item.from_path, name), posix.join(placed, name));
      this.setItem(item.job_id, item.seq, { status: 'done', error: null });
    }).immediate();
  }

  // Where a copied folder goes under the member's collision choice: refused, a free "name (n)", or the old one to the
  // target's trash first.
  private async folderTarget(to: StorageBackend, path: string, policy: CollisionPolicy): Promise<string> {
    if (!await statOrNull(to, path)) return path;
    if (policy === 'fail') throw new AppError('FILE_EXISTS', { name: posix.basename(path) });
    if (policy === 'replace') { await to.delete([path]); return path; }
    for (let n = 1; n < 1000; n++) {
      const candidate = `${path} (${n})`;
      if (!await statOrNull(to, candidate)) return candidate;
    }
    throw new AppError('FILE_EXISTS', { name: posix.basename(path) });
  }

  // Once no item of the job is pending or in flight: a move deletes its sources, then the job gets its final status.
  private settle(jobId: string): void {
    if (this.stopping || this.finishing.has(jobId)) return;
    if ([...this.active.values()].some((a) => a.jobId === jobId)) return;
    const { db } = this.deps;
    const job = db.prepare(`SELECT * FROM transfer_jobs WHERE id = ?`).get(jobId) as JobRow | undefined;
    if (!job) return;
    const open = db.prepare(`SELECT count(*) FROM transfer_items WHERE job_id = ? AND status IN ('pending','active')`).pluck().get(jobId) as number;
    if (open > 0) return;
    if (job.status !== 'running' && (job.mode !== 'move' || job.status !== 'cancelled')) return;
    const work = (async () => {
      if (job.mode === 'move') await this.deleteMovedSources(job);
      if (job.status === 'running') {
        const notDone = db.prepare(`SELECT count(*) FROM transfer_items WHERE job_id = ? AND status != 'done'`).pluck().get(jobId) as number;
        db.prepare(`UPDATE transfer_jobs SET status = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
          .run(notDone === 0 ? 'completed' : 'completed_with_errors', new Date().toISOString(), jobId);
      }
    })().catch((e: unknown) => { this.log.error({ err: e, job: jobId }, 'finishing a transfer job failed'); }) // handled: logged; the job stays running and is finished again at the next start
      .finally(() => { this.finishing.delete(jobId); if (!this.stopping) this.emit(jobId); });
    this.finishing.set(jobId, work);
  }

  // The source of every done item goes, and only of done items: a folder as a whole where everything beneath it is
  // done, other files one by one. A source that cannot be deleted turns its item failed, so the job reports it.
  private async deleteMovedSources(job: JobRow): Promise<void> {
    const { db } = this.deps;
    const items = db.prepare(`SELECT * FROM transfer_items WHERE job_id = ? ORDER BY seq`).all(job.id) as ItemRow[];
    const bySeq = new Map(items.map((i) => [i.seq, i]));
    const complete = new Map<number, boolean>();
    const isComplete = (i: ItemRow): boolean => {
      if (complete.has(i.seq)) return complete.get(i.seq)!;
      const ok = i.status === 'done' && items.filter((c) => c.parent === i.seq).every(isComplete);
      complete.set(i.seq, ok);
      return ok;
    };
    // The topmost complete items: their parent folder (if any) is not complete, so it stays with whatever failed.
    const roots = items.filter((i) => isComplete(i) && (i.parent === null || !isComplete(bySeq.get(i.parent)!)));
    const user = getUser(db, job.user_id);
    if (!user) return;
    const from = (await sourceFor(this.deps, user, job.from_source)).backend;
    for (const i of roots) {
      try { await from.delete([i.from_path]); }
      catch (e) {
        if (isNotFound(e)) continue; // handled: already gone (a finish interrupted by a restart deleted it)
        if (!(e instanceof AppError)) this.log.error({ err: e, job: job.id }, 'deleting a moved source failed');
        this.setItem(job.id, i.seq, { status: 'failed', error: e instanceof AppError ? e.code : 'INTERNAL' });
      }
    }
  }
}
