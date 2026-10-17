import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import { pipeline, Readable, Transform } from 'node:stream';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { PICKED_NAMES, planRenames, type CleanupPreview, type CollisionPolicy, type CreateMigrationRequest, type CreateTransferRequest,
  type Entry, type ErrorCode, type MigrationScan, type RenamePlan, type RenameRequest, type TransferJob,
  type TransferStatus } from '@files/shared';
import { AppError } from '../errors.ts';
import { getUser, type User } from '../users.ts';
import type { StorageBackend } from './backend.ts';
import { normalizeUserPath } from './resolveInRoot.ts';
import { parseSource, sourceFor, type ResolvedSource } from './resolveSource.ts';
import { deleteComments, keysOf } from './comments.ts';
import { followMove } from './followRefs.ts';

/** Items copied at once, over all jobs of all members: enough to overlap round trips, few enough for provider limits. */
export const TRANSFER_CONCURRENCY = 2;
/** Progress events per job at most this often while bytes flow; every state change is sent at once. */
const PROGRESS_MS = 250;
/** A transfer is not an upload: the member's quota limits what lands in the home, not the upload size limit. */
const MAX_BYTES = Number.MAX_SAFE_INTEGER;
/** Jobs a member sees in the panel, newest first. */
const LIST_LIMIT = 50;
/** How long a cleanup confirmation token stays valid (#153). */
const CLEANUP_TOKEN_MS = 10 * 60_000;
/** A migration scan stops after this many entries or this long and reports `complete: false` (#153). */
export const SCAN_MAX_ENTRIES = 50_000;
export const SCAN_MS = 15_000;
/** Item rows per query of the summary export, so it never holds a whole job's rows. */
const REPORT_PAGE = 500;

type Deps = FastifyInstance['deps'];
type Kind = 'transfer' | 'migration' | 'cleanup' | 'rename';
type JobRow = { id: string; user_id: string; kind: Kind; origin: string | null; mode: 'copy' | 'move'; from_source: string;
  to_source: string; dir: string; status: TransferStatus; created_at: string; finished_at: string | null;
  cleanup_token: string | null; cleanup_expires: string | null };
type ItemRow = { job_id: string; seq: number; parent: number | null; from_path: string; to_path: string;
  on_collision: CollisionPolicy; type: 'file' | 'directory' | null; placed: string | null; status: string; error: string | null;
  bytes: number; sha256: string | null; src_modified: string | null; verified: string | null };
type NewItem = Pick<ItemRow, 'from_path' | 'to_path' | 'on_collision'> & Partial<Pick<ItemRow, 'type' | 'placed' | 'bytes' | 'sha256' | 'src_modified'>>;
/** Why an item's work was aborted: the member cancelled the job, or the app is shutting down (the item resumes later). */
type AbortReason = 'cancel' | 'stop';

const isNotFound = (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND';
async function statOrNull(b: StorageBackend, path: string) {
  return b.stat(path).then((e) => e, (e: unknown) => { if (isNotFound(e)) return null; throw e; }); // handled: absent is null
}
const sha256 = (s: string) => createHash('sha256').update(s).digest();

/**
 * What a migration of `path` would copy: files, folders beneath it and bytes, walked breadth-first through `list`. The
 * walk stops after SCAN_MAX_ENTRIES entries or SCAN_MS and then reports `complete: false`.
 */
export async function scanFolder(b: StorageBackend, path: string, limits = { entries: SCAN_MAX_ENTRIES, ms: SCAN_MS }): Promise<MigrationScan> {
  const root = normalizeUserPath(path);
  if ((await b.stat(root)).type !== 'directory') throw new AppError('NOT_A_DIRECTORY');
  const end = Date.now() + limits.ms;
  const queue = [root];
  let files = 0; let folders = 0; let bytes = 0;
  while (queue.length) {
    if (files + folders >= limits.entries || Date.now() > end) return { files, folders, bytes, complete: false };
    const dir = queue.shift()!;
    let cursor: string | undefined;
    do {
      const page = await b.list(dir, cursor);
      for (const e of page.entries) {
        if (e.type === 'directory') { folders++; queue.push(posix.join(dir, e.name)); } else { files++; bytes += e.size; }
      }
      cursor = page.next;
    } while (cursor);
  }
  return { files, folders, bytes, complete: true };
}

const csvCell = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csvLine = (cells: (string | number | null)[]) => `${cells.map(csvCell).join(',')}\r\n`;

/**
 * Copies and moves between sources as persistent jobs (spec §3.4, #152). A job row and one row per item live in SQLite;
 * workers run in this process, at most TRANSFER_CONCURRENCY items at a time. A file item is done only after the target
 * holds exactly the bytes sent: its size, and its SHA-256 where a side offers `digest`, plus the provider's own hash where
 * its `read` gives one. A folder item is done once its target folder exists and its children are items of the job. A
 * move deletes the source of done items when the job ends (whole folders where everything beneath them is done), so a
 * failed item always keeps its source. Jobs still running at start-up resume: items in flight start again, done ones are
 * never redone.
 *
 * A migration (#153) is a copy of one connection's folder into a new folder of the home. Its cleanup is a job of its own
 * whose items are exactly the migration's verified files; each is checked again (the shard copy and the original are
 * unchanged) right before the original is deleted, into the provider's trash.
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
    const user = this.user(userId);
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
    return this.insertJob({ user, kind: 'transfer', mode: req.mode, from: req.from, to: req.to, dir },
      items.map((i) => ({ from_path: i.from, to_path: posix.join(dir, posix.basename(i.from)), on_collision: i.onCollision })));
  }

  /**
   * The plan of a batch rename (#215) as the member would get it now: the folder is listed, every item must be one of
   * its entries, and `planRenames` (the same call the job makes) turns names, operations and chosen policies into rows.
   * Needs `edit` on the source.
   */
  async previewRename(userId: string, req: RenameRequest): Promise<RenamePlan> {
    return (await this.renamePlan(this.user(userId), req)).plan;
  }

  /**
   * A batch rename (#215): the plan computed again from the folder as it is now, refused with RENAME_CONFLICT while any
   * conflict lacks a policy; otherwise one job (kind `rename`) with one item per name that changes. Each item is one
   * `move` of the source (atomic in the home), so a failure fails that item only and the job lists it.
   */
  async createRename(userId: string, req: RenameRequest): Promise<TransferJob> {
    const user = this.user(userId);
    const { plan, dir } = await this.renamePlan(user, req);
    if (plan.blocked) throw new AppError('RENAME_CONFLICT');
    const rows = plan.rows.filter((r) => r.action === 'rename');
    if (!rows.length) throw new AppError('VALIDATION');
    return this.insertJob({ user, kind: 'rename', mode: 'move', from: req.source, to: req.source, dir },
      rows.map((r) => ({ from_path: r.path, to_path: posix.join(dir, r.to), on_collision: r.onCollision })));
  }

  private async renamePlan(user: User, req: RenameRequest): Promise<{ plan: RenamePlan; dir: string }> {
    const src = await sourceFor(this.deps, user, req.source);
    if (src.access !== 'edit') throw new AppError('FORBIDDEN');
    const dir = normalizeUserPath(req.dir);
    const paths = req.items.map((i) => normalizeUserPath(i.path));
    if (new Set(paths).size !== paths.length || paths.some((p) => p === '/' || posix.dirname(p) !== dir)) throw new AppError('VALIDATION');
    const listed = new Map<string, Entry>();
    let cursor: string | undefined;
    do {
      const page = await src.backend.list(dir, cursor);
      for (const e of page.entries) listed.set(e.name, e);
      cursor = page.next;
    } while (cursor);
    const items = paths.map((p, i) => {
      const e = listed.get(posix.basename(p));
      if (!e) throw new AppError('NOT_FOUND');
      return { path: p, name: e.name, type: e.type, ...(req.items[i]!.policy ? { policy: req.items[i]!.policy } : {}) };
    });
    return { plan: planRenames(items, [...listed.keys()], req.ops), dir };
  }

  /**
   * A migration (#153): the folder `path` of one of the member's own connections (`/` is the whole account) into a new
   * folder `name` of the home folder `dir`. One folder item with "keep both", so it never lands in a folder the member
   * already has; whatever the job then writes into that folder is its own.
   */
  async createMigration(userId: string, req: CreateMigrationRequest): Promise<TransferJob> {
    const user = this.user(userId);
    if (parseSource(req.from).kind !== 'conn') throw new AppError('VALIDATION');
    const from = await sourceFor(this.deps, user, req.from);
    const path = normalizeUserPath(req.path);
    if ((await from.backend.stat(path)).type !== 'directory') throw new AppError('NOT_A_DIRECTORY');
    const to = await sourceFor(this.deps, user, 'home');
    const dir = normalizeUserPath(req.dir);
    const target = normalizeUserPath(posix.join(dir, req.name));
    if (target === dir || posix.dirname(target) !== dir) throw new AppError('VALIDATION');
    if ((await to.backend.stat(dir)).type !== 'directory') throw new AppError('NOT_A_DIRECTORY');
    return this.insertJob({ user, kind: 'migration', mode: 'copy', from: req.from, to: 'home', dir },
      [{ from_path: path, to_path: target, on_collision: 'keep-both', type: 'directory' }]);
  }

  /**
   * What a cleanup of the member's ended migration would delete, with a new single-use confirmation token (valid for
   * CLEANUP_TOKEN_MS; only its hash is stored, and a new preview replaces it).
   */
  previewCleanup(userId: string, id: string): CleanupPreview {
    const job = this.ownMigration(userId, id);
    if (job.status === 'running') throw new AppError('JOB_RUNNING');
    const token = randomBytes(16).toString('hex');
    const { db } = this.deps;
    db.prepare(`UPDATE transfer_jobs SET cleanup_token = ?, cleanup_expires = ? WHERE id = ?`)
      .run(sha256(token).toString('hex'), new Date(Date.now() + CLEANUP_TOKEN_MS).toISOString(), id);
    const r = db.prepare(`SELECT count(*) AS files, coalesce(sum(bytes), 0) AS bytes FROM transfer_items
      WHERE job_id = ? AND type = 'file' AND status = 'done'`).get(id) as { files: number; bytes: number };
    return { token, ...r };
  }

  /**
   * Starts the cleanup of the member's ended migration, confirmed by the token of its last preview: a job (kind
   * `cleanup`) with one item per verified file of the migration and nothing else. The token is used up.
   */
  async startCleanup(userId: string, id: string, token: string): Promise<TransferJob> {
    const job = this.ownMigration(userId, id);
    if (job.status === 'running') throw new AppError('JOB_RUNNING');
    const stored = job.cleanup_token ? Buffer.from(job.cleanup_token, 'hex') : null;
    const valid = stored !== null && job.cleanup_expires !== null && Date.parse(job.cleanup_expires) > Date.now()
      && timingSafeEqual(stored, sha256(token));
    if (!valid) throw new AppError('CONFIRMATION_REQUIRED');
    const user = this.user(userId);
    // Deleting needs edit on the connection; the job's own checks run again for every item.
    if ((await sourceFor(this.deps, user, job.from_source)).access !== 'edit') throw new AppError('FORBIDDEN');
    const { db } = this.deps;
    // Single use, also against a second request racing this one.
    if (db.prepare(`UPDATE transfer_jobs SET cleanup_token = NULL, cleanup_expires = NULL WHERE id = ? AND cleanup_token = ?`)
      .run(id, job.cleanup_token).changes !== 1) throw new AppError('CONFIRMATION_REQUIRED');
    const verified = db.prepare(`SELECT * FROM transfer_items WHERE job_id = ? AND type = 'file' AND status = 'done' ORDER BY seq`)
      .all(id) as ItemRow[];
    const root = db.prepare(`SELECT coalesce(placed, to_path) FROM transfer_items WHERE job_id = ? AND parent IS NULL ORDER BY seq LIMIT 1`)
      .pluck().get(id) as string;
    return this.insertJob({ user, kind: 'cleanup', origin: id, mode: 'move', from: job.from_source, to: job.to_source, dir: root },
      verified.map((i) => ({ from_path: i.from_path, to_path: i.placed!, placed: i.placed!, on_collision: 'fail', type: 'file',
        bytes: i.bytes, sha256: i.sha256, src_modified: i.src_modified })));
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

  /**
   * The summary export of the member's own job (#153): CSV, one row per item in job order (status, source path, path in
   * the target, type, bytes, the checks it passed, the error code). Read page by page from the rows as it is sent.
   */
  report(userId: string, id: string): Readable {
    this.own(userId, id);
    const page = this.deps.db.prepare(`SELECT seq, status, from_path, placed, type, bytes, verified, error FROM transfer_items
      WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?`);
    return Readable.from((function* () {
      yield csvLine(['status', 'source_path', 'shard_path', 'type', 'bytes', 'verified', 'error']);
      for (let after = -1; ;) {
        const rows = page.all(id, after, REPORT_PAGE) as ItemRow[];
        for (const r of rows) yield csvLine([r.status, r.from_path, r.placed, r.type, r.bytes, r.verified, r.error]);
        if (rows.length < REPORT_PAGE) return;
        after = rows.at(-1)!.seq;
      }
    })());
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

  /** Removes one finished job of the member's from the list (#234); a running job is refused with JOB_RUNNING. */
  dismiss(userId: string, id: string): void {
    if (this.own(userId, id).status === 'running') throw new AppError('JOB_RUNNING');
    this.deps.db.prepare(`DELETE FROM transfer_jobs WHERE id = ? AND status != 'running'`).run(id);
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

  private user(userId: string): User {
    const user = getUser(this.deps.db, userId);
    if (!user) throw new AppError('UNAUTHENTICATED');
    return user;
  }

  private own(userId: string, id: string): JobRow {
    const job = this.deps.db.prepare(`SELECT * FROM transfer_jobs WHERE id = ? AND user_id = ?`).get(id, userId) as JobRow | undefined;
    if (!job) throw new AppError('NOT_FOUND');
    return job;
  }

  private ownMigration(userId: string, id: string): JobRow {
    const job = this.own(userId, id);
    if (job.kind !== 'migration') throw new AppError('NOT_FOUND');
    return job;
  }

  private insertJob(job: { user: User; kind: Kind; origin?: string; mode: 'copy' | 'move'; from: string; to: string; dir: string },
    items: NewItem[]): TransferJob {
    const id = randomBytes(16).toString('hex');
    const { db } = this.deps;
    db.transaction(() => {
      db.prepare(`INSERT INTO transfer_jobs (id, user_id, kind, origin, mode, from_source, to_source, dir, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`)
        .run(id, job.user.id, job.kind, job.origin ?? null, job.mode, job.from, job.to, job.dir, new Date().toISOString());
      const insert = db.prepare(`INSERT INTO transfer_items (job_id, seq, from_path, to_path, on_collision, type, placed, bytes,
        sha256, src_modified, status) VALUES (@job, @seq, @from_path, @to_path, @on_collision, @type, @placed, @bytes, @sha256,
        @src_modified, 'pending')`);
      items.forEach((i, seq) => insert.run({ type: null, placed: null, bytes: 0, sha256: null, src_modified: null, ...i, job: id, seq }));
    }).immediate();
    this.emit(id);
    this.settle(id); // a job without items (a cleanup with nothing verified) ends at once
    this.pump();
    return this.view(id);
  }

  private view(id: string): TransferJob {
    const { db } = this.deps;
    const job = db.prepare(`SELECT * FROM transfer_jobs WHERE id = ?`).get(id) as JobRow;
    const counts = Object.fromEntries((db.prepare(`SELECT status, count(*) AS n FROM transfer_items WHERE job_id = ? GROUP BY status`)
      .all(id) as { status: string; n: number }[]).map((r) => [r.status, r.n]));
    const failed = (db.prepare(`SELECT from_path, error FROM transfer_items WHERE job_id = ? AND status = 'failed' ORDER BY seq`)
      .all(id) as { from_path: string; error: ErrorCode }[]).map((r) => ({ path: r.from_path, code: r.error }));
    const done = db.prepare(`SELECT coalesce(sum(bytes), 0) AS bytes, count(CASE WHEN type = 'file' THEN 1 END) AS files
      FROM transfer_items WHERE job_id = ? AND status = 'done'`).get(id) as { bytes: number; files: number };
    const known = db.prepare(`SELECT count(CASE WHEN type = 'file' THEN 1 END) AS files,
      count(CASE WHEN status IN ('pending', 'active') AND (type IS NULL OR type = 'directory') THEN 1 END) AS unlisted
      FROM transfer_items WHERE job_id = ?`).get(id) as { files: number; unlisted: number };
    let flowing = 0;
    for (const [key, n] of this.inflight) if (key.startsWith(`${id}:`)) flowing += n;
    const first = db.prepare(`SELECT from_path, coalesce(placed, to_path) AS target FROM transfer_items WHERE job_id = ? ORDER BY seq LIMIT 1`)
      .get(id) as { from_path: string; target: string } | undefined;
    // A transfer and a rename are named by the first item picked, a migration by its new folder (once placed, the free
    // name it got), a cleanup by the migration's folder.
    const name = job.kind === 'transfer' || job.kind === 'rename' ? posix.basename(first!.from_path)
      : posix.basename(job.kind === 'migration' ? first!.target : job.dir);
    // What the member picked (#234): the items without a parent. A migration and a cleanup are one thing, named as above.
    const byPick = job.kind === 'transfer' || job.kind === 'rename';
    const picked = byPick ? db.prepare(`SELECT count(*) FROM transfer_items WHERE job_id = ? AND parent IS NULL`).pluck().get(id) as number : 1;
    const names = byPick ? (db.prepare(`SELECT from_path FROM transfer_items WHERE job_id = ? AND parent IS NULL ORDER BY seq LIMIT ?`)
      .pluck().all(id, PICKED_NAMES) as string[]).map((p) => posix.basename(p)) : [name];
    return { id, kind: job.kind, origin: job.origin, mode: job.mode, from: job.from_source, to: job.to_source, dir: job.dir, name,
      picked, names,
      status: job.status, total: Object.values(counts).reduce((a, b) => a + b, 0), done: counts.done ?? 0, verifiedFiles: done.files,
      files: known.files, listing: job.status === 'running' && known.unlisted > 0, cancelled: counts.cancelled ?? 0, failed, bytes: job.kind === 'cleanup' ? done.bytes : done.bytes + flowing,
      createdAt: job.created_at, finishedAt: job.finished_at };
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

  // Starts pending items of running jobs, oldest job first, until the concurrency is used. Within a job, folders (and
  // items not yet looked at) go before files, so its totals are complete early (#227).
  private pump(): void {
    const { db } = this.deps;
    while (!this.stopping && this.active.size < TRANSFER_CONCURRENCY) {
      const next = db.prepare(`SELECT i.job_id AS jobId, i.seq FROM transfer_items i JOIN transfer_jobs j ON j.id = i.job_id
        WHERE i.status = 'pending' AND j.status = 'running' ORDER BY j.created_at, j.id, i.type IS 'file', i.seq LIMIT 1`)
        .get() as { jobId: string; seq: number } | undefined;
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

  private setItem(jobId: string, seq: number,
    fields: Partial<Pick<ItemRow, 'status' | 'error' | 'bytes' | 'placed' | 'type' | 'sha256' | 'src_modified' | 'verified'>>): void {
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
      if (job.kind === 'cleanup') {
        await this.removeOriginal(item, from.backend, to.backend);
        deleteComments(db, [keysOf(db, job.user_id, job.from_source)(item.from_path)]);
        this.setItem(jobId, seq, { status: 'done', error: null });
        return;
      }
      if (job.kind === 'rename') {
        // One move within the source, under the policy the plan gave it (#215); the rows on the item follow it.
        const placed = await from.backend.move(item.from_path, item.to_path, item.on_collision);
        followMove(db, job.user_id, job.from_source, item.from_path, placed.path);
        this.setItem(jobId, seq, { status: 'done', error: null, placed: placed.path, type: placed.type });
        return;
      }
      const entry = await from.backend.stat(item.from_path);
      this.setItem(jobId, seq, { type: entry.type });
      if (entry.type === 'directory') await this.copyFolder(item, from.backend, to.backend);
      else this.setItem(jobId, seq, { status: 'done', error: null, ...await this.copyFile(item, from.backend, to.backend, signal) });
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

  /** Streams one file and verifies the target; returns the verified size and the checks it passed. */
  private async copyFile(item: ItemRow, from: StorageBackend, to: StorageBackend, signal: AbortSignal): Promise<{ bytes: number; verified: string }> {
    const key = `${item.job_id}:${item.seq}`;
    const src = await from.read(item.from_path);
    const hash = createHash('sha256');
    const providerHash = src.hash && !src.unsized ? { ...src.hash, hash: createHash(src.hash.algorithm) } : undefined;
    let sent = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        hash.update(chunk); providerHash?.hash.update(chunk); sent += chunk.length;
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
    const sum = hash.digest('hex');
    // What was received is kept with the placed path: a cleanup (#153) compares the shard copy with it later.
    this.setItem(item.job_id, item.seq, { placed: written.path, sha256: sum, src_modified: src.entry.modified ?? null });
    // Verification (#99): what was read must be what the source announced, and the target must hold exactly that.
    if (!src.unsized && sent !== src.entry.size) throw new AppError('SIZE_MISMATCH');
    const stored = await to.stat(written.path);
    if (stored.type !== 'file' || stored.size !== sent) throw new AppError('VERIFY_FAILED');
    const checks = ['size'];
    if (to.digest && await to.digest(written.path) !== sum) throw new AppError('VERIFY_FAILED');
    if (from.digest && await from.digest(item.from_path) !== sum) throw new AppError('VERIFY_FAILED');
    if (to.digest || from.digest) checks.push('sha256');
    // The provider's own hash of the file (#153): the bytes received must be the ones it stores.
    if (providerHash) {
      if (providerHash.hash.digest('hex') !== providerHash.value) throw new AppError('VERIFY_FAILED');
      checks.push(providerHash.algorithm);
    }
    return { bytes: sent, verified: checks.join(' ') };
  }

  /**
   * One original of a cleanup (#153): deleted, into the provider's trash, only while it is still verified. The shard copy
   * must be a file of the verified size with the SHA-256 that was received, and the original must still have the size
   * and modified time it was migrated with. An original already gone has nothing left to delete.
   */
  private async removeOriginal(item: ItemRow, from: StorageBackend, to: StorageBackend): Promise<void> {
    if (!to.digest || item.sha256 === null) throw new AppError('COPY_CHANGED');
    const copy = await statOrNull(to, item.to_path);
    if (copy?.type !== 'file' || copy.size !== item.bytes || await to.digest(item.to_path) !== item.sha256) throw new AppError('COPY_CHANGED');
    const original = await statOrNull(from, item.from_path);
    if (!original) return;
    if (original.type !== 'file' || original.size !== item.bytes || (original.modified ?? null) !== item.src_modified) {
      throw new AppError('SOURCE_CHANGED');
    }
    await from.delete([item.from_path]);
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
    const children: { name: string; type: 'file' | 'directory' }[] = [];
    let cursor: string | undefined;
    do {
      const page = await from.list(item.from_path, cursor);
      for (const e of page.entries) children.push({ name: e.name, type: e.type });
      cursor = page.next;
    } while (cursor);
    const { db } = this.deps;
    db.transaction(() => {
      let seq = db.prepare(`SELECT max(seq) FROM transfer_items WHERE job_id = ?`).pluck().get(item.job_id) as number;
      // The folder is this job's own, so whatever lies in it came from this job (an earlier attempt): replace it. The type
      // from the listing orders the work and counts the files; each item's own stat confirms it when it runs.
      const insert = db.prepare(`INSERT INTO transfer_items (job_id, seq, parent, from_path, to_path, on_collision, type, status)
        VALUES (?, ?, ?, ?, ?, 'replace', ?, 'pending')`);
      for (const c of children) {
        insert.run(item.job_id, ++seq, item.seq, posix.join(item.from_path, c.name), posix.join(placed, c.name), c.type);
      }
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
    // A cleanup is a `move` only for the rights it needs; its items delete their originals themselves.
    const moves = job.mode === 'move' && job.kind === 'transfer';
    if (job.status !== 'running' && (!moves || job.status !== 'cancelled')) return;
    const work = (async () => {
      if (moves) await this.deleteMovedSources(job);
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
    // A cloud original's comment threads go with it, as with a delete through the sources route (#213).
    const keyOf = keysOf(db, user.id, job.from_source);
    for (const i of roots) {
      try { await from.delete([i.from_path]); deleteComments(db, [keyOf(i.from_path)]); }
      catch (e) {
        if (isNotFound(e)) continue; // handled: already gone (a finish interrupted by a restart deleted it)
        if (!(e instanceof AppError)) this.log.error({ err: e, job: job.id }, 'deleting a moved source failed');
        this.setItem(job.id, i.seq, { status: 'failed', error: e instanceof AppError ? e.code : 'INTERNAL' });
      }
    }
  }
}
