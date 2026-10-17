import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { DuplicateGroup, DuplicateScan, Entry, ErrorCode, HashAlgorithm, StartDuplicateScanRequest, TrashDuplicatesRequest,
  TrashDuplicatesResult } from '@files/shared';
import { AppError } from '../errors.ts';
import { getUser, type User } from '../users.ts';
import { hashOf, type StorageBackend } from './backend.ts';
import { followDelete } from './followRefs.ts';
import { normalizeUserPath } from './resolveInRoot.ts';
import { parseSource, sourceFor } from './resolveSource.ts';

type Deps = FastifyInstance['deps'];
/** Files one scan lists at most over all its sources; beyond that it stops listing and reports `complete: false`. */
export const SCAN_MAX_FILES = 200_000;

type Copy = { source: string; path: string; name: string; size: number; modified?: string; mime?: string;
  hash?: { algorithm: HashAlgorithm; value: string } };
type Group = { size: number; algorithm: HashAlgorithm; value: string; copies: Copy[] };
type Scan = { state: DuplicateScan; groups: Group[]; ctl: AbortController; promise: Promise<void> };

const idle = (): DuplicateScan => ({ status: 'idle', sources: [], files: 0, candidates: 0, hashed: 0, unhashed: 0, complete: true,
  failed: [], groups: [], startedAt: null, finishedAt: null });
const codeOf = (e: unknown): ErrorCode => (e instanceof AppError ? e.code : 'INTERNAL');
const byAge = (a: Copy, b: Copy) => (a.modified ?? '￿').localeCompare(b.modified ?? '￿') || a.path.localeCompare(b.path);

/**
 * The duplicate finder (#216). A scan per member runs in this process: it lists the chosen sources, keeps only files
 * whose size another file shares, and groups those by hash: the home's SHA-256 (computed lazily, cached in
 * `content_hashes` with size and mtime, read within the shard's byte budget), a cloud's own hash as its listing gives
 * it (never guessed; files without one are counted as `unhashed`). Hashes are only compared within one algorithm, so a
 * home file and a cloud file are never one group. A scan can be cancelled; its result lives until the next scan or a
 * restart. Nothing is deleted by a scan: `trash` moves copies the member picked to their source's trash, each only
 * after its size and hash were checked again and a copy that stays was found unchanged (#100).
 */
export class DuplicateFinder {
  private scans = new Map<string, Scan>();
  // The byte budget, over every scan: the time the budget is spent until.
  private paidUntil = 0;

  constructor(private deps: Deps, private log: FastifyBaseLogger) {}

  /** The member's last scan, or an idle one. */
  get(userId: string): DuplicateScan {
    const s = this.scans.get(userId);
    return s ? { ...s.state, failed: [...s.state.failed], groups: s.groups.map(view) } : idle();
  }

  async start(userId: string, req: StartDuplicateScanRequest): Promise<DuplicateScan> {
    const user = this.user(userId);
    if (this.scans.get(userId)?.state.status === 'running') throw new AppError('SCAN_RUNNING');
    const sources = [...new Set(req.sources)];
    // The member's own storage only: a share is someone else's, and its owner decides about its copies.
    if (sources.some((s) => parseSource(s).kind === 'share')) throw new AppError('VALIDATION');
    for (const s of sources) await sourceFor(this.deps, user, s);
    const ctl = new AbortController();
    const state: DuplicateScan = { ...idle(), status: 'running', sources, startedAt: new Date().toISOString() };
    const scan: Scan = { state, groups: [], ctl, promise: Promise.resolve() };
    this.scans.set(userId, scan);
    const end = () => { state.finishedAt = new Date().toISOString(); };
    const cancelled = () => { state.status = 'cancelled'; scan.groups = []; end(); };
    scan.promise = this.run(user, scan).then(() => { if (ctl.signal.aborted) cancelled(); else end(); }, (e: unknown) => {
      if (!ctl.signal.aborted) this.log.error({ err: e }, 'duplicate scan failed');
      cancelled(); // handled: logged; the scan ends as cancelled and the member can start it again
    });
    return this.get(userId);
  }

  /** Stops the member's running scan; nothing it found is kept. */
  async cancel(userId: string): Promise<DuplicateScan> {
    const s = this.scans.get(userId);
    if (s?.state.status === 'running') {
      s.ctl.abort();
      await s.promise;
    }
    return this.get(userId);
  }

  async stop(): Promise<void> {
    for (const s of this.scans.values()) s.ctl.abort();
    await Promise.all([...this.scans.values()].map((s) => s.promise));
  }

  /**
   * Moves copies of the last completed scan's groups to their sources' trash. The request is refused as a whole when a
   * copy is not in a group (NOT_FOUND) or it would take every copy of a group (DUPLICATE_LAST_COPY). Then, per group, a
   * copy that stays must still have the group's size and hash; per picked copy, its size and hash are checked again
   * right before its delete. A copy that no longer matches is kept (DUPLICATE_CHANGED).
   */
  async trash(userId: string, req: TrashDuplicatesRequest): Promise<TrashDuplicatesResult> {
    const user = this.user(userId);
    const scan = this.scans.get(userId);
    if (scan?.state.status !== 'completed') throw new AppError('NOT_FOUND');
    const picked = new Map<Group, Set<Copy>>();
    for (const item of req.items) {
      const path = normalizeUserPath(item.path);
      const group = scan.groups.find((g) => g.copies.some((c) => c.source === item.source && c.path === path));
      if (!group) throw new AppError('NOT_FOUND');
      const set = picked.get(group) ?? new Set();
      set.add(group.copies.find((c) => c.source === item.source && c.path === path)!);
      picked.set(group, set);
    }
    for (const [g, set] of picked) if (set.size >= g.copies.length) throw new AppError('DUPLICATE_LAST_COPY');
    const results: TrashDuplicatesResult['results'] = [];
    for (const [g, set] of picked) {
      const stays = await this.anyUnchanged(user, g, g.copies.filter((c) => !set.has(c)));
      for (const c of set) {
        try {
          if (!stays) throw new AppError('DUPLICATE_CHANGED');
          const backend = await this.editable(user, c.source);
          await this.check(backend, c, g);
          await backend.delete([c.path]);
          followDelete(this.deps.db, user.id, c.source, [c.path]);
          g.copies = g.copies.filter((o) => o !== c);
          results.push({ source: c.source, path: c.path, trashed: true });
        } catch (e) {
          if (!(e instanceof AppError)) this.log.error({ err: e }, 'moving a duplicate to the trash failed');
          results.push({ source: c.source, path: c.path, trashed: false, code: codeOf(e) }); // handled: reported per copy
        }
      }
    }
    scan.groups = scan.groups.filter((g) => g.copies.length > 1);
    return { results };
  }

  private user(userId: string): User {
    const user = getUser(this.deps.db, userId);
    if (!user) throw new AppError('UNAUTHENTICATED');
    return user;
  }

  private async editable(user: User, source: string): Promise<StorageBackend> {
    const r = await sourceFor(this.deps, user, source);
    if (r.access !== 'edit') throw new AppError('FORBIDDEN');
    return r.backend;
  }

  // The copy as it is now must be a file of the group's size with the group's hash: the home's SHA-256 read again from
  // the disk (never the cache), a cloud's hash from a fresh stat.
  private async check(b: StorageBackend, c: Copy, g: Group): Promise<void> {
    const now = await b.stat(c.path);
    if (now.type !== 'file' || now.size !== g.size) throw new AppError('DUPLICATE_CHANGED');
    const value = g.algorithm === 'sha256' ? (b.digest ? await b.digest(c.path) : undefined)
      : hashOf(now)?.algorithm === g.algorithm ? hashOf(now)!.value : undefined;
    if (value !== g.value) throw new AppError('DUPLICATE_CHANGED');
  }

  private async anyUnchanged(user: User, g: Group, kept: Copy[]): Promise<boolean> {
    for (const c of kept) {
      try {
        await this.check((await sourceFor(this.deps, user, c.source)).backend, c, g);
        return true;
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        continue; // handled: this copy changed or is gone; the next one may still hold the content
      }
    }
    return false;
  }

  private async run(user: User, scan: Scan): Promise<void> {
    const { state, ctl: { signal } } = scan;
    const files: Copy[] = [];
    for (const source of state.sources) {
      if (signal.aborted) return;
      try {
        await this.walk((await sourceFor(this.deps, user, source)).backend, source, files, scan);
      } catch (e) {
        if (signal.aborted) return;
        if (!(e instanceof AppError)) this.log.error({ err: e, source }, 'listing a source for duplicates failed');
        state.failed.push({ source, code: codeOf(e) }); // handled: the source is reported as failed, the others go on
      }
    }
    // Same size first: a file whose size no other file has cannot have a duplicate, and is never hashed. Empty files
    // are all alike and are not offered.
    const bySize = new Map<number, Copy[]>();
    for (const f of files) if (f.size > 0) bySize.set(f.size, [...bySize.get(f.size) ?? [], f]);
    const candidates = [...bySize.values()].filter((l) => l.length > 1).flat();
    state.candidates = candidates.length;
    const home = state.sources.includes('home') ? (await sourceFor(this.deps, user, 'home')).backend : null;
    for (const c of candidates) {
      if (signal.aborted) return;
      if (c.source !== 'home') {
        if (!c.hash) state.unhashed++;
      } else {
        try { c.hash = { algorithm: 'sha256', value: await this.homeHash(user.id, home!, c, signal) }; }
        catch (e) {
          if (signal.aborted) return;
          if (!(e instanceof AppError)) throw e;
          state.unhashed++; // handled: the file went away or changed into something else while scanning; it is left out
        }
      }
      state.hashed++;
    }
    const groups = new Map<string, Group>();
    for (const c of candidates) {
      if (!c.hash) continue;
      const key = `${c.hash.algorithm}:${c.hash.value}:${c.size}`;
      const g = groups.get(key) ?? { size: c.size, algorithm: c.hash.algorithm, value: c.hash.value, copies: [] };
      g.copies.push(c);
      groups.set(key, g);
    }
    if (signal.aborted) return;
    scan.groups = [...groups.values()].filter((g) => g.copies.length > 1)
      .map((g) => ({ ...g, copies: g.copies.sort(byAge) })).sort((a, b) => b.size - a.size);
    state.status = 'completed';
  }

  // Every file beneath the source's root, breadth first, until the scan's file limit.
  private async walk(b: StorageBackend, source: string, out: Copy[], scan: Scan): Promise<void> {
    const queue = ['/'];
    while (queue.length) {
      const dir = queue.shift()!;
      let cursor: string | undefined;
      do {
        if (scan.ctl.signal.aborted) return;
        const page = await b.list(dir, cursor);
        for (const e of page.entries) {
          if (e.type === 'directory') { queue.push(posix.join(dir, e.name)); continue; }
          if (scan.state.files >= SCAN_MAX_FILES) { scan.state.complete = false; return; }
          out.push(copyOf(source, e));
          scan.state.files++;
        }
        cursor = page.next;
      } while (cursor);
    }
  }

  // The SHA-256 of a home file: the cached one while size and mtime still match, else read within the byte budget.
  private async homeHash(userId: string, home: StorageBackend, c: Copy, signal: AbortSignal): Promise<string> {
    const { db } = this.deps;
    const row = db.prepare('SELECT size, mtime, sha256 FROM content_hashes WHERE user_id = ? AND path = ?').get(userId, c.path) as
      { size: number; mtime: string; sha256: string } | undefined;
    if (row && row.size === c.size && row.mtime === c.modified) return row.sha256;
    const { entry, stream } = await home.read(c.path);
    const hash = createHash('sha256');
    try {
      for await (const chunk of stream) {
        await this.pace((chunk as Buffer).length, signal);
        hash.update(chunk as Buffer);
      }
    } finally {
      stream.destroy();
    }
    const value = hash.digest('hex');
    db.prepare(`INSERT INTO content_hashes (user_id, path, size, mtime, sha256) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, sha256 = excluded.sha256`)
      .run(userId, c.path, entry.size, entry.modified ?? '', value);
    return value;
  }

  // Reading `bytes` costs time in the budget; this waits until the bytes read before them are paid for.
  private async pace(bytes: number, signal: AbortSignal): Promise<void> {
    const now = Date.now();
    const start = Math.max(this.paidUntil, now);
    this.paidUntil = start + (bytes * 1000) / this.deps.config.duplicateScanBytesPerSecond;
    if (start > now) await sleep(start - now, undefined, { signal });
    signal.throwIfAborted();
  }
}

function copyOf(source: string, e: Entry): Copy {
  const h = hashOf(e);
  return { source, path: e.path, name: e.name, size: e.size, ...(e.modified ? { modified: e.modified } : {}),
    ...(e.mime ? { mime: e.mime } : {}), ...(h ? { hash: h } : {}) };
}

const view = (g: Group): DuplicateGroup => ({ id: `${g.algorithm}:${g.value}:${g.size}`, size: g.size, algorithm: g.algorithm,
  copies: g.copies.map((c) => ({ source: c.source, path: c.path, name: c.name, ...(c.modified ? { modified: c.modified } : {}),
    ...(c.mime ? { mime: c.mime } : {}) })) });
