import { constants, createWriteStream, linkSync, lstatSync, renameSync, unlinkSync } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readdir, rename, rm, truncate, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, posix } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { CollisionPolicy, Entry, ThumbSize, TrashItem } from '@files/shared';
import { AppError } from '../errors.ts';
import { normalizeUserPath, resolveInRoot } from './resolveInRoot.ts';
import { RangeNotSatisfiable, type ByteRange, type StorageBackend, type WriteOptions } from './backend.ts';
import { lookupMime } from './mime.ts';
import type { Db } from '../db.ts';
import { deletePathRefs, deleteTrashRefs, movePathRefs, type PathTable, type TrashTable } from './pathRefs.ts';
import { recordRecent } from './recent.ts';
import type { ThumbnailCache } from './thumbnails.ts';

export const INTERNAL = '.files';
export const TEMP_NAME = /^\.[0-9a-f]{16}\.upload$/;
const TRASH_ID = /^[0-9a-f]{32}$/;
export const UPLOAD_ID = /^[0-9a-f]{32}$/;
const DAY_MS = 86_400_000;
/** An upload expires this long after it was created or last received bytes. */
export const UPLOAD_TTL_MS = DAY_MS;
type TrashRow = { id: string; original_path: string; type: 'file' | 'directory'; size: number; deleted_at: string };
type UploadRow = { id: string; source: string; path: string; length: number; received: number; on_collision: CollisionPolicy; expires_at: string };
/** What HEAD reports; `entry` is set once the bytes have been placed at their target. */
export type UploadState = { id: string; offset: number; length: number; expiresAt: string; entry?: Entry };

// One request at a time per upload (tus forbids concurrent PATCHes); the app runs as one process.
const busyUploads = new Set<string>();
async function withUpload<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (busyUploads.has(id)) throw new AppError('UPLOAD_LOCKED');
  busyUploads.add(id);
  try { return await fn(); } finally { busyUploads.delete(id); }
}

// Restore and purge of one member's trash run one at a time, so a purge never removes bytes a restore is moving.
const userLocks = new Map<string, Promise<unknown>>();
function underUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined); // handled: the caller gets the error from `run`
  userLocks.set(userId, tail);
  void tail.then(() => { if (userLocks.get(userId) === tail) userLocks.delete(userId); });
  return run;
}

// Bytes of the regular files in a tree (0 for anything that is gone); symlinks are neither followed nor counted.
export async function treeSize(abs: string): Promise<number> {
  const st = await lstat(abs).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) return undefined; throw e; });
  if (!st) return 0;
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let sum = 0;
  for (const name of await readdir(abs)) sum += await treeSize(join(abs, name));
  return sum;
}
const MAX_NAME_BYTES = 255;
const MAX_LIMIT = 1000;
const isErr = (e: unknown, code: string) => (e as NodeJS.ErrnoException).code === code;
// Inode in the tag: a replace with identical size and mtime still changes it.
const etagOf = (st: { ino: number; size: number; mtimeMs: number }) =>
  `"${st.ino.toString(16)}-${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;

// Translate low-level errno into API errors; anything else passes through unchanged.
export function mapFsError(e: unknown): unknown {
  if (isErr(e, 'ENOSPC') || isErr(e, 'EDQUOT')) return new AppError('STORAGE_FULL', undefined, { cause: e });
  if (isErr(e, 'ENAMETOOLONG')) return new AppError('PATH_INVALID', undefined, { cause: e });
  return e;
}
const rethrowMapped = (e: unknown): never => { throw mapFsError(e); };

type SortKey = { d: 0 | 1; n: string };
const cmpKey = (a: SortKey, b: SortKey): number =>
  a.d !== b.d ? b.d - a.d : (a.n.localeCompare(b.n, 'en') || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));

function decodeCursor(cursor: string): SortKey {
  let v: unknown;
  try { v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch (e) { throw new AppError('VALIDATION', undefined, { cause: e }); }
  const k = v as Partial<SortKey> | null;
  if (!k || typeof k !== 'object' || (k.d !== 0 && k.d !== 1) || typeof k.n !== 'string') throw new AppError('VALIDATION');
  return { d: k.d, n: k.n };
}

// A listed name must round-trip through normalizeUserPath unchanged, else it could not be addressed again.
function addressable(name: string): boolean {
  if (name.includes('\uFFFD') || TEMP_NAME.test(name)) return false; // U+FFFD: invalid UTF-8 on disk
  try { return normalizeUserPath('/' + name) === '/' + name; }
  catch { return false; } // handled: unaddressable on-disk name is skipped
}

function truncateBytes(s: string, max: number): string {
  let out = ''; let bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > max) break;
    out += ch; bytes += n;
  }
  return out;
}

async function syncDir(dir: string): Promise<void> {
  const dh = await open(dir, 'r');
  try { await dh.sync(); } finally { await dh.close(); }
}

/**
 * The database side of a home: path-dependent rows and trash rows change in the same transaction as the files.
 * `thumbs` is the app's thumbnail cache; a backend without it (the expiry jobs, unit tests) has no `thumbnail`.
 */
export type HomeIndex = { db: Db; userId: string; pathTables: readonly PathTable[]; trashTables: readonly TrashTable[];
  thumbs?: ThumbnailCache };

// Renames done inside a database transaction; undone in reverse order when anything after them fails.
class FsSteps {
  private done: [string, string][] = [];
  rename(from: string, to: string): void {
    try { renameSync(from, to); }
    catch (e) {
      if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND', undefined, { cause: e });
      if (isErr(e, 'EEXIST') || isErr(e, 'ENOTEMPTY')) throw new AppError('FILE_EXISTS', { name: basename(to) }, { cause: e });
      throw e;
    }
    this.done.push([from, to]);
  }
  /** Moves `from` to the first free name of `candidates` (a hard link refuses a taken name atomically). */
  linkInto(from: string, candidates: readonly string[]): string {
    for (const c of candidates) {
      try { linkSync(from, c); }
      catch (e) { if (isErr(e, 'EEXIST')) continue; throw e; } // handled: the name is taken, the next candidate is tried
      unlinkSync(from);
      this.done.push([from, c]);
      return c;
    }
    throw new AppError('FILE_EXISTS', { name: basename(candidates[0]!) });
  }
  undo(cause: unknown): void {
    for (const [from, to] of this.done.reverse()) {
      try { renameSync(to, from); }
      catch (e) { throw new AggregateError([cause, e], `could not undo the rename to ${to}`, { cause: e }); }
    }
  }
}

// Copies a file or a folder tree; files go through copy_file_range in the kernel, never through a buffer in memory.
async function copyTree(src: string, dst: string): Promise<void> {
  const st = await lstat(src).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND'); throw e; });
  if (st.isSymbolicLink()) throw new AppError('PATH_SYMLINK');
  if (st.isDirectory()) {
    await mkdir(dst);
    // On-disk names, not user input. An in-flight upload's temp file is not part of the folder yet.
    for (const name of await readdir(src)) if (!TEMP_NAME.test(name)) await copyTree(join(src, name), join(dst, name));
    await syncDir(dst);
  } else if (st.isFile()) {
    await copyFile(src, dst, constants.COPYFILE_EXCL);
    const fh = await open(dst, 'r');
    try { await fh.sync(); } finally { await fh.close(); }
  } else {
    throw new AppError('PATH_INVALID');
  }
}

export class LocalBackend implements StorageBackend {
  constructor(private root: string, private index: HomeIndex) {}

  // Every user path goes through here: normalise, refuse the internal area and temp names, resolve inside the root.
  private async abs(p: string) {
    const n = normalizeUserPath(p);
    if (n === `/${INTERNAL}` || n.startsWith(`/${INTERNAL}/`)) throw new AppError('PATH_INVALID');
    if (n !== '/' && TEMP_NAME.test(basename(n))) throw new AppError('PATH_INVALID');
    await mkdir(this.root, { recursive: true });
    return resolveInRoot(this.root, n);
  }

  private entry(userPath: string, st: { isDirectory(): boolean; size: number; mtime: Date }): Entry {
    const path = normalizeUserPath(userPath);
    const name = path === '/' ? '/' : basename(path);
    const isDir = st.isDirectory();
    return { name, path, type: isDir ? 'directory' : 'file', size: isDir ? 0 : st.size,
      modified: st.mtime.toISOString(), ...(isDir ? {} : { mime: lookupMime(name) }) };
  }

  stat(p: string): Promise<Entry> { return this.statImpl(p).catch(rethrowMapped); }
  list(p: string, cursor?: string, limit = 500) { return this.listImpl(p, cursor, limit).catch(rethrowMapped); }
  read(p: string, range?: ByteRange | ((size: number) => ByteRange | undefined)) { return this.readImpl(p, range).catch(rethrowMapped); }
  mkdir(p: string): Promise<Entry> { return this.mkdirImpl(p).catch(rethrowMapped); }
  write(p: string, body: Readable, opts: WriteOptions): Promise<Entry> {
    return this.writeImpl(p, body, opts).catch(rethrowMapped);
  }
  move(from: string, to: string, onCollision: CollisionPolicy): Promise<Entry> {
    return this.moveImpl(from, to, onCollision).catch(rethrowMapped);
  }
  copy(from: string, to: string, onCollision: CollisionPolicy): Promise<Entry> {
    return this.copyImpl(from, to, onCollision).catch(rethrowMapped);
  }
  delete(paths: readonly string[]): Promise<void> { return this.deleteImpl(paths).catch(rethrowMapped); }
  thumbnail(p: string, size: ThumbSize): Promise<Readable | null> { return this.thumbnailImpl(p, size).catch(rethrowMapped); }

  private async thumbnailImpl(p: string, size: ThumbSize): Promise<Readable | null> {
    const { thumbs, userId } = this.index;
    if (!thumbs) throw new Error('this LocalBackend was built without a thumbnail cache');
    const a = await this.abs(p);
    const st = await lstat(a).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND'); throw e; });
    if (st.isDirectory()) throw new AppError('IS_A_DIRECTORY');
    if (!st.isFile()) throw new AppError('NOT_FOUND');
    return thumbs.get({ userId, path: normalizeUserPath(p), abs: a, etag: etagOf(st), mime: lookupMime(basename(a)) }, size);
  }

  // After a write, move or delete has landed: the thumbnails of the paths it touched (and beneath them) go. A stale one
  // would never be served anyway (the ETag check), so this only frees the cache at once.
  private async forgetThumbs(...paths: string[]): Promise<void> {
    for (const p of new Set(paths)) await this.index.thumbs?.forget(this.index.userId, p);
  }

  // The internal area goes through the same resolver; only this class may name it.
  private async internalDir(name: 'trash' | 'tmp' | 'uploads'): Promise<string> {
    await mkdir(this.root, { recursive: true });
    const d = await resolveInRoot(this.root, `/${INTERNAL}/${name}`);
    await mkdir(d, { recursive: true });
    return d;
  }

  // One SQLite write transaction around the filesystem steps: a failure anywhere rolls the rows back and undoes the
  // renames, so neither a ghost row nor a lost file is left behind (#117).
  private atomically<T>(fn: (fs: FsSteps) => T): T {
    const fs = new FsSteps();
    try { return this.index.db.transaction(() => fn(fs)).immediate(); }
    catch (e) { fs.undo(e); throw e; }
  }

  private async endpoints(from: string, to: string, policy: CollisionPolicy) {
    const nf = normalizeUserPath(from); const nt = normalizeUserPath(to);
    if (nf === '/' || nt === '/') throw new AppError('PATH_INVALID');
    const src = await this.abs(nf); const dst = await this.abs(nt);
    const st = await lstat(src).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND'); throw e; });
    if (!st.isFile() && !st.isDirectory()) throw new AppError('NOT_FOUND');
    if (st.isDirectory() && nt.startsWith(nf + '/')) throw new AppError('TARGET_INSIDE_SOURCE');
    // Replacing a folder that holds the source would send the source to the trash along with it.
    if (policy === 'replace' && nf.startsWith(nt + '/')) throw new AppError('TARGET_INSIDE_SOURCE');
    const parent = await lstat(dirname(dst)).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND'); throw e; });
    if (!parent.isDirectory()) throw new AppError('NOT_A_DIRECTORY');
    return { nf, nt, src, dst, type: st.isDirectory() ? 'directory' as const : 'file' as const };
  }

  // Inside the transaction: the absolute path the item may take. "replace" sends the existing item to the trash;
  // `replacedSize` is its size, measured before the transaction.
  private claim(fs: FsSteps, trash: string, dst: string, userPath: string, policy: CollisionPolicy, replacedSize: number): string {
    if (!lstatSync(dst, { throwIfNoEntry: false })) return dst;
    if (policy === 'fail') throw new AppError('FILE_EXISTS', { name: basename(dst) });
    if (policy === 'keep-both') {
      for (let i = 1; i < 1000; i++) {
        const c = numbered(dst, i);
        if (!lstatSync(c, { throwIfNoEntry: false })) return c;
      }
      throw new AppError('FILE_EXISTS', { name: basename(dst) });
    }
    this.trashSync(fs, trash, dst, userPath, replacedSize);
    return dst;
  }

  // Inside the transaction: move one item into the trash, cascade its path rows, record the trash row. `treeBytes` is
  // the folder's size, measured before the transaction (a file's size comes from its lstat).
  private trashSync(fs: FsSteps, trash: string, abs: string, userPath: string, treeBytes: number): void {
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st || !(st.isFile() || st.isDirectory())) throw new AppError('NOT_FOUND');
    const id = randomBytes(16).toString('hex');
    fs.rename(abs, join(trash, id));
    const { db, userId, pathTables } = this.index;
    deletePathRefs(db, pathTables, userId, userPath);
    db.prepare('INSERT INTO trash (id, user_id, original_path, type, size, deleted_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, userPath, st.isDirectory() ? 'directory' : 'file', st.isDirectory() ? treeBytes : st.size, new Date().toISOString());
  }

  private async moveImpl(from: string, to: string, policy: CollisionPolicy): Promise<Entry> {
    const e = await this.endpoints(from, to, policy);
    if (e.nf === e.nt) return this.statImpl(e.nf); // onto itself: nothing to do
    const trash = await this.internalDir('trash');
    const replacedSize = policy === 'replace' ? await treeSize(e.dst) : 0;
    const placed = this.atomically((fs) => {
      const target = this.claim(fs, trash, e.dst, e.nt, policy, replacedSize);
      fs.rename(e.src, target);
      const rel = join(dirname(e.nt), basename(target));
      const { db, userId, pathTables } = this.index;
      // The target is free here (or was trashed with its rows), so rows still pointing there are stale: changed outside
      // the app. They give way, else they would collide with the rows the move brings along.
      deletePathRefs(db, pathTables, userId, rel);
      movePathRefs(db, pathTables, userId, e.nf, rel);
      recordRecent(db, userId, rel, e.type);
      return rel;
    });
    for (const d of new Set([dirname(e.src), dirname(e.dst), trash])) await syncDir(d);
    await this.forgetThumbs(e.nf, e.nt, placed);
    return this.statImpl(placed);
  }

  private async copyImpl(from: string, to: string, policy: CollisionPolicy): Promise<Entry> {
    const e = await this.endpoints(from, to, policy);
    const trash = await this.internalDir('trash');
    // Built in the internal area first, so a half-done copy is never visible; the startup sweep clears what a crash leaves.
    const stage = join(await this.internalDir('tmp'), randomBytes(16).toString('hex'));
    try {
      await copyTree(e.src, stage);
      const replacedSize = policy === 'replace' ? await treeSize(e.dst) : 0;
      const placed = this.atomically((fs) => {
        const target = this.claim(fs, trash, e.dst, e.nt, policy, replacedSize);
        fs.rename(stage, target);
        const rel = join(dirname(e.nt), basename(target));
        recordRecent(this.index.db, this.index.userId, rel, e.type);
        return rel;
      });
      for (const d of new Set([dirname(e.dst), trash])) await syncDir(d);
      await this.forgetThumbs(placed);
      return await this.statImpl(placed);
    } catch (err) {
      await rm(stage, { recursive: true, force: true });
      throw err;
    }
  }

  private async deleteImpl(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) throw new AppError('VALIDATION');
    const norm = [...new Set(paths.map(normalizeUserPath))];
    if (norm.includes('/')) throw new AppError('PATH_INVALID');
    // An item beneath another selected one goes to the trash with it.
    const top = norm.filter((p) => !norm.some((q) => p.startsWith(q + '/')));
    const items: { p: string; a: string; size: number }[] = [];
    for (const p of top) { const a = await this.abs(p); items.push({ p, a, size: await treeSize(a) }); }
    const trash = await this.internalDir('trash');
    this.atomically((fs) => { for (const it of items) this.trashSync(fs, trash, it.a, it.p, it.size); });
    for (const d of new Set([...items.map((it) => dirname(it.a)), trash])) await syncDir(d);
    await this.forgetThumbs(...items.map((it) => it.p));
  }

  /** The member's trash, newest first. */
  trashItems(retentionDays: number): TrashItem[] {
    const rows = this.index.db.prepare('SELECT id, original_path, type, size, deleted_at FROM trash WHERE user_id = ? ORDER BY deleted_at DESC, id')
      .all(this.index.userId) as TrashRow[];
    return rows.map((r) => ({
      id: r.id, name: posix.basename(r.original_path), originalPath: r.original_path, type: r.type, size: r.size,
      deletedAt: r.deleted_at, expiresAt: new Date(Date.parse(r.deleted_at) + retentionDays * DAY_MS).toISOString(),
    }));
  }

  /**
   * Puts one trashed item back at its original path, recreating missing parent folders. A taken name follows the
   * collision policy like any move: never a silent overwrite, and "replace" sends the taken item to the trash.
   */
  restore(id: string, policy: CollisionPolicy): Promise<Entry> {
    return underUserLock(this.index.userId, () => this.restoreImpl(id, policy)).catch(rethrowMapped);
  }

  /**
   * The one way anything leaves the trash for good: single delete, empty trash and expiry all come here. Per item the
   * bytes go first; only then are the row and the rows hanging off it deleted, in one transaction. If the bytes cannot
   * be removed the row stays (so the next attempt finds the item again), the error is logged and the id is reported in
   * `failed`. `'all'` is the member's whole trash. An id without a row fails the call before anything is touched, or
   * is left out with `missing: 'skip'` (the expiry job, whose rows may have been restored meanwhile).
   */
  purge(ids: readonly string[] | 'all', log: FastifyBaseLogger, missing: 'fail' | 'skip' = 'fail'): Promise<{ purged: string[]; failed: string[] }> {
    return underUserLock(this.index.userId, () => this.purgeImpl(ids, log, missing));
  }

  private trashRow(id: string): TrashRow | undefined {
    return this.index.db.prepare('SELECT id, original_path, type, size, deleted_at FROM trash WHERE id = ? AND user_id = ?')
      .get(id, this.index.userId) as TrashRow | undefined;
  }

  // The bytes of a trash item, through the same resolver as every other path; only this class names the internal area.
  private async trashBytes(id: string): Promise<string> {
    if (!TRASH_ID.test(id)) throw new AppError('VALIDATION');
    await this.internalDir('trash');
    return resolveInRoot(this.root, `/${INTERNAL}/trash/${id}`);
  }

  private async restoreImpl(id: string, policy: CollisionPolicy): Promise<Entry> {
    const row = this.trashRow(id);
    if (!row) throw new AppError('NOT_FOUND');
    const src = await this.trashBytes(id);
    const trash = await this.internalDir('trash');
    const nt = normalizeUserPath(row.original_path);
    const dst = await this.abs(nt); // refuses symlinks and files on the way, like any user path
    await mkdir(dirname(dst), { recursive: true }).catch((e) => {
      if (isErr(e, 'ENOTDIR') || isErr(e, 'EEXIST')) throw new AppError('NOT_A_DIRECTORY', undefined, { cause: e });
      throw e;
    });
    const replacedSize = policy === 'replace' ? await treeSize(dst) : 0;
    const placed = this.atomically((fs) => {
      const target = this.claim(fs, trash, dst, nt, policy, replacedSize);
      fs.rename(src, target);
      this.index.db.prepare('DELETE FROM trash WHERE id = ? AND user_id = ?').run(id, this.index.userId);
      const rel = join(dirname(nt), basename(target));
      recordRecent(this.index.db, this.index.userId, rel, row.type);
      return rel;
    });
    for (const d of new Set([dirname(dst), trash])) await syncDir(d);
    await this.forgetThumbs(placed);
    return this.statImpl(placed);
  }

  private async purgeImpl(ids: readonly string[] | 'all', log: FastifyBaseLogger, missing: 'fail' | 'skip') {
    const { db, userId, trashTables } = this.index;
    let todo: string[];
    if (ids === 'all') todo = db.prepare('SELECT id FROM trash WHERE user_id = ?').pluck().all(userId) as string[];
    else {
      const unique = [...new Set(ids)];
      todo = unique.filter((id) => this.trashRow(id));
      if (missing === 'fail' && todo.length !== unique.length) throw new AppError('NOT_FOUND');
    }
    const result = { purged: [] as string[], failed: [] as string[] };
    if (todo.length === 0) return result;
    const trash = await this.internalDir('trash');
    for (const id of todo) {
      try {
        // rm never follows a symlink inside the tree; `force` makes bytes that are already gone count as removed.
        await rm(await this.trashBytes(id), { recursive: true, force: true });
      } catch (e) { // handled: the row stays so the item is found again, the error is logged and the id reported as failed
        log.error({ err: e, trashId: id, userId }, 'trash purge could not remove the bytes; the row stays');
        result.failed.push(id);
        continue;
      }
      db.transaction(() => {
        deleteTrashRefs(db, trashTables, id);
        db.prepare('DELETE FROM trash WHERE id = ? AND user_id = ?').run(id, userId);
      }).immediate();
      result.purged.push(id);
    }
    await syncDir(trash);
    return result;
  }

  /**
   * Bytes the member may still add: the quota minus everything under the home (trash and staged uploads included) minus
   * what open uploads other than `exceptUpload` have yet to send. Infinity without a quota.
   */
  private async remainingQuota(exceptUpload?: string): Promise<number> {
    const free = await this.freeBeforeReservations();
    return free === Infinity ? free : Math.max(0, free - this.reserved(exceptUpload));
  }

  // Quota minus the bytes under the home; Infinity without a quota. The walk is async, so callers that must not race
  // subtract `reserved()` inside their transaction.
  private async freeBeforeReservations(): Promise<number> {
    const quota = this.index.db.prepare('SELECT quota_bytes FROM users WHERE id = ?').pluck().get(this.index.userId) as number | null | undefined;
    if (quota === null || quota === undefined) return Infinity;
    return quota - await treeSize(this.root);
  }

  private reserved(exceptUpload?: string): number {
    return this.index.db.prepare('SELECT COALESCE(SUM(length - received), 0) FROM uploads WHERE user_id = ? AND id IS NOT ?')
      .pluck().get(this.index.userId, exceptUpload ?? null) as number;
  }

  private uploadRow(id: string): UploadRow | undefined {
    if (!UPLOAD_ID.test(id)) return undefined;
    return this.index.db.prepare('SELECT id, source, path, length, received, on_collision, expires_at FROM uploads WHERE id = ? AND user_id = ?')
      .get(id, this.index.userId) as UploadRow | undefined;
  }

  // The staged bytes of an upload, through the same resolver as every other path; only this class names the internal area.
  private async uploadBytes(id: string): Promise<string> {
    if (!UPLOAD_ID.test(id)) throw new AppError('NOT_FOUND');
    await this.internalDir('uploads');
    return resolveInRoot(this.root, `/${INTERNAL}/uploads/${id}`);
  }

  // The member's own upload or NOT_FOUND: another member's id looks exactly like one that never existed.
  private ownUpload(id: string): UploadRow {
    const row = this.uploadRow(id);
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  }

  /**
   * Opens a resumable upload of `length` bytes to `path`. Everything that can be refused is refused here, before a byte
   * is stored: the size limit, the quota (counting what other open uploads still have to send), the path, a folder in
   * the way, and a taken name under `fail`. The bytes collect in `<home>/.files/uploads/<id>`.
   */
  createUpload(u: { source: string; path: string; length: number; onCollision: CollisionPolicy; maxBytes: number }): Promise<UploadState> {
    return this.createUploadImpl(u).catch(rethrowMapped);
  }

  private async createUploadImpl(u: { source: string; path: string; length: number; onCollision: CollisionPolicy; maxBytes: number }) {
    if (u.length > u.maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');
    const nt = normalizeUserPath(u.path);
    if (nt === '/') throw new AppError('PATH_INVALID');
    const target = await this.abs(nt);
    const st = await lstat(target).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) return undefined; throw e; });
    if (st?.isDirectory()) throw new AppError('IS_A_DIRECTORY');
    if (st && u.onCollision === 'fail') throw new AppError('FILE_EXISTS', { name: basename(target) });
    const free = await this.freeBeforeReservations();
    const { db, userId } = this.index;
    const id = randomBytes(16).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + UPLOAD_TTL_MS).toISOString();
    // Reservation check and insert under one write lock, so two uploads created at once cannot both take the last bytes.
    db.transaction(() => {
      if (free !== Infinity && u.length > free - this.reserved()) throw new AppError('QUOTA_EXCEEDED');
      db.prepare(`INSERT INTO uploads (id, user_id, source, path, length, received, on_collision, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(id, userId, u.source, nt, u.length, u.onCollision, now.toISOString(), expiresAt);
    }).immediate();
    try {
      const fh = await open(await this.uploadBytes(id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
      await fh.close();
    } catch (e) {
      db.prepare('DELETE FROM uploads WHERE id = ? AND user_id = ?').run(id, userId);
      throw e;
    }
    return { id, offset: 0, length: u.length, expiresAt };
  }

  /** HEAD: how many bytes are safely stored. */
  uploadState(id: string): UploadState {
    const row = this.ownUpload(id);
    return { id, offset: row.received, length: row.length, expiresAt: row.expires_at };
  }

  /**
   * PATCH: appends the body at `offset`, which must be what is stored. Never more than the declared length is stored:
   * a client that sends more is cut off and the whole upload is dropped (#113). Whatever arrived before a dropped
   * connection is fsynced and recorded, so the client resumes from there. Once all bytes are in, they are placed at the
   * target with the upload's collision policy; a name taken meanwhile under `fail` answers FILE_EXISTS and keeps the
   * bytes for `finishUpload`.
   */
  async appendUpload(id: string, offset: number, body: Readable, declared?: number): Promise<UploadState> {
    this.ownUpload(id);
    return withUpload(id, () => this.appendImpl(id, offset, body, declared)).catch(rethrowMapped);
  }

  private async appendImpl(id: string, offset: number, body: Readable, declared?: number): Promise<UploadState> {
    const row = this.ownUpload(id);
    if (offset !== row.received) throw new AppError('OFFSET_MISMATCH', { offset: row.received });
    const rest = row.length - row.received;
    if (declared !== undefined && declared > rest) { await this.dropUpload(id); throw new AppError('SIZE_MISMATCH'); }
    if (rest > 0 && rest > await this.remainingQuota(id)) throw new AppError('QUOTA_EXCEEDED');
    const file = await this.uploadBytes(id);
    const before = await lstat(file).then((s) => s, (e) => {
      if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND', undefined, { cause: e });
      throw e;
    });
    if (!before.isFile()) throw new Error(`staged bytes of upload ${id} are not a regular file`);
    // Only what was recorded counts: bytes written after the last fsync but before a crash are dropped again.
    if (before.size < row.received) throw new Error(`staged bytes of upload ${id} are shorter than recorded`);
    await truncate(file, row.received);
    let over = false; let failure: unknown;
    let written = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        if (written > rest) { over = true; return cb(new AppError('SIZE_MISMATCH')); }
        cb(null, chunk);
      },
    });
    await pipeline(body, limiter, createWriteStream(file, { flags: 'r+', start: row.received }))
      .catch((e: unknown) => { failure = e; }); // handled: what arrived is fsynced and recorded below, then the error is rethrown
    const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let size: number;
    try { await fh.sync(); size = (await fh.stat()).size; } finally { await fh.close(); }
    if (over) { await this.dropUpload(id); throw new AppError('SIZE_MISMATCH'); }
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS).toISOString();
    this.index.db.prepare('UPDATE uploads SET received = ?, expires_at = ? WHERE id = ? AND user_id = ?').run(size, expiresAt, id, this.index.userId);
    if (failure !== undefined) throw failure;
    const state: UploadState = { id, offset: size, length: row.length, expiresAt };
    if (size < row.length) return state;
    return { ...state, entry: await this.placeUpload({ ...row, received: size }, row.on_collision) };
  }

  /** Places a complete upload whose name was taken at the end, with the policy the user chose then. */
  async finishUpload(id: string, policy: CollisionPolicy): Promise<Entry> {
    this.ownUpload(id);
    return withUpload(id, async () => {
      const row = this.ownUpload(id);
      if (row.received !== row.length) throw new AppError('SIZE_MISMATCH');
      return this.placeUpload(row, policy);
    }).catch(rethrowMapped);
  }

  /** Termination: the staged bytes and the row go. */
  async terminateUpload(id: string): Promise<void> {
    this.ownUpload(id);
    return withUpload(id, () => this.dropUpload(id)).catch(rethrowMapped);
  }

  /**
   * The expiry job: drops this member's uploads that expired before `now`, skipping one that is receiving bytes right
   * now. Bytes first, then the row, so a failure leaves the row for the next run.
   */
  async expireUploads(now: Date, log: FastifyBaseLogger): Promise<{ removed: string[]; failed: string[] }> {
    const ids = this.index.db.prepare('SELECT id FROM uploads WHERE user_id = ? AND expires_at < ?').pluck()
      .all(this.index.userId, now.toISOString()) as string[];
    const result = { removed: [] as string[], failed: [] as string[] };
    for (const id of ids) {
      if (busyUploads.has(id)) continue;
      try { await withUpload(id, () => this.dropUpload(id)); result.removed.push(id); }
      catch (e) { // handled: logged with the upload id and reported as failed; the row stays for the next run
        log.error({ err: e, uploadId: id, userId: this.index.userId }, 'upload expiry could not remove an upload');
        result.failed.push(id);
      }
    }
    return result;
  }

  private async dropUpload(id: string): Promise<void> {
    await rm(await this.uploadBytes(id), { force: true });
    this.index.db.prepare('DELETE FROM uploads WHERE id = ? AND user_id = ?').run(id, this.index.userId);
  }

  // Moves the staged bytes to the target and deletes the row in one transaction (renames undone if the commit fails).
  // Missing parent folders are created, which is how a folder upload recreates its structure.
  private async placeUpload(row: UploadRow, policy: CollisionPolicy): Promise<Entry> {
    const nt = normalizeUserPath(row.path);
    const target = await this.abs(nt);
    await mkdir(dirname(target), { recursive: true }).catch((e) => {
      if (isErr(e, 'ENOTDIR') || isErr(e, 'EEXIST')) throw new AppError('NOT_A_DIRECTORY', undefined, { cause: e });
      throw e;
    });
    const st = await lstat(target).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) return undefined; throw e; });
    if (st?.isDirectory()) throw new AppError('IS_A_DIRECTORY');
    const staged = await this.uploadBytes(row.id);
    const { db, userId } = this.index;
    const placed = this.atomically((fs) => {
      let final: string;
      if (policy === 'replace') { fs.rename(staged, target); final = target; }
      else final = fs.linkInto(staged, policy === 'fail' ? [target] : Array.from({ length: 1000 }, (_, i) => i === 0 ? target : numbered(target, i)));
      db.prepare('DELETE FROM uploads WHERE id = ? AND user_id = ?').run(row.id, userId);
      recordRecent(db, userId, join(dirname(nt), basename(final)), 'file');
      return final;
    });
    for (const d of new Set([dirname(target), dirname(staged)])) await syncDir(d);
    const rel = join(dirname(nt), basename(placed));
    await this.forgetThumbs(rel);
    return this.statImpl(rel);
  }

  private async statImpl(p: string): Promise<Entry> {
    const a = await this.abs(p);
    const st = await lstat(a).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND'); throw e; });
    if (!st.isFile() && !st.isDirectory()) throw new AppError('NOT_FOUND');
    return this.entry(p, st);
  }

  private async listImpl(p: string, cursor: string | undefined, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new AppError('VALIDATION');
    const after = cursor ? decodeCursor(cursor) : undefined;
    const a = await this.abs(p);
    let dirents;
    try { dirents = await readdir(a, { withFileTypes: true }); }
    catch (e) {
      if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND');
      if (isErr(e, 'ENOTDIR')) throw new AppError('NOT_A_DIRECTORY');
      throw e;
    }
    const base = normalizeUserPath(p);
    const keyed = dirents
      .filter((d) => !(base === '/' && d.name === INTERNAL) && (d.isFile() || d.isDirectory()) && addressable(d.name))
      .map((d) => ({ d, key: { d: d.isDirectory() ? 1 : 0, n: d.name } as SortKey }))
      .sort((x, y) => cmpKey(x.key, y.key))
      .filter((x) => !after || cmpKey(x.key, after) > 0);
    const slice = keyed.slice(0, limit);
    const found = await Promise.all(slice.map(async ({ d }) => {
      const child = (base === '/' ? '' : base) + '/' + d.name;
      const st = await lstat(join(a, d.name)).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) return undefined; throw e; });
      return st && (st.isFile() || st.isDirectory()) ? this.entry(child, st) : undefined; // undefined: raced with delete
    }));
    const entries = found.filter((e): e is Entry => e !== undefined);
    const last = slice[slice.length - 1];
    return keyed.length > limit && last
      ? { entries, next: Buffer.from(JSON.stringify(last.key)).toString('base64url') }
      : { entries };
  }

  private async readImpl(p: string, wanted?: ByteRange | ((size: number) => ByteRange | undefined)) {
    const a = await this.abs(p);
    // lstat first: opening a FIFO would block; O_NOFOLLOW + fh.stat() below close the race.
    const pre = await lstat(a).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND'); throw e; });
    if (pre.isDirectory()) throw new AppError('IS_A_DIRECTORY');
    if (!pre.isFile()) throw new AppError('NOT_FOUND');
    const fh = await open(a, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((e) => {
      if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND');
      if (isErr(e, 'ELOOP')) throw new AppError('PATH_SYMLINK');
      throw e;
    });
    try {
      const st = await fh.stat();
      if (st.isDirectory()) throw new AppError('IS_A_DIRECTORY');
      if (!st.isFile()) throw new AppError('NOT_FOUND');
      const range = typeof wanted === 'function' ? wanted(st.size) : wanted;
      if (range && (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.start > range.end || range.end >= st.size)) {
        throw new RangeNotSatisfiable(st.size);
      }
      const stream = fh.createReadStream({ autoClose: true, ...(range ? { start: range.start, end: range.end } : {}) });
      return { entry: this.entry(p, st), stream, etag: etagOf(st), ...(range ? { range } : {}) };
    } catch (e) {
      await fh.close();
      throw e;
    }
  }

  private async mkdirImpl(p: string): Promise<Entry> {
    const a = await this.abs(p);
    await mkdir(dirname(a), { recursive: true });
    await mkdir(a).catch((e) => { if (isErr(e, 'EEXIST')) throw new AppError('FILE_EXISTS'); throw e; });
    return this.statImpl(p);
  }

  private async writeImpl(p: string, body: Readable, opts: WriteOptions): Promise<Entry> {
    if (opts.ifMatch !== undefined && opts.onCollision !== 'replace') throw new AppError('VALIDATION');
    if (opts.size !== undefined && opts.size > opts.maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');
    const target = await this.abs(p);
    const dir = dirname(target);
    await mkdir(dir, { recursive: true });
    const current = () => lstat(target).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) return undefined; throw e; });
    const st = await current();
    if (st?.isDirectory()) throw new AppError('IS_A_DIRECTORY');
    // Fail fast so the client can ask the user before sending the body; place() still catches a name taken meanwhile.
    if (st && opts.onCollision === 'fail') throw new AppError('FILE_EXISTS', { name: basename(target) });
    // Checked before the body is read (fail fast) and again just before the rename (narrows the lost-update window).
    const checkIfMatch = (s: Awaited<ReturnType<typeof current>>) => {
      if (opts.ifMatch !== undefined && (!s?.isFile() || etagOf(s) !== opts.ifMatch)) throw new AppError('PRECONDITION_FAILED');
    };
    checkIfMatch(st);
    const quotaLeft = await this.remainingQuota();
    if (opts.size !== undefined && opts.size > quotaLeft) throw new AppError('QUOTA_EXCEEDED');
    const tmp = join(dir, `.${randomBytes(8).toString('hex')}.upload`);
    let written = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        if (written > opts.maxBytes) return cb(new AppError('PAYLOAD_TOO_LARGE'));
        if (written > quotaLeft) return cb(new AppError('QUOTA_EXCEEDED'));
        cb(opts.size !== undefined && written > opts.size ? new AppError('SIZE_MISMATCH') : null, chunk);
      },
    });
    try {
      await pipeline(body, limiter, createWriteStream(tmp, { flags: 'wx' }));
      if (opts.size !== undefined && written !== opts.size) throw new AppError('SIZE_MISMATCH');
      const fh = await open(tmp, 'r+'); await fh.sync(); await fh.close();
      checkIfMatch(await current());
      const finalPath = await this.place(tmp, target, opts.onCollision);
      // The rename/link lives in the directory entry; without this a crash can lose the file after we answered 201.
      await syncDir(dir);
      const rel = join(dirname(normalizeUserPath(p)), basename(finalPath));
      const { db, userId } = this.index;
      db.transaction(() => recordRecent(db, userId, rel, 'file')).immediate();
      await this.forgetThumbs(rel);
      return this.statImpl(rel);
    } catch (e) {
      await unlink(tmp).catch((u) => { if (!isErr(u, 'ENOENT')) throw u; }); // handled: tmp may not exist yet
      throw e;
    }
  }

  private async place(tmp: string, target: string, policy: CollisionPolicy): Promise<string> {
    if (policy === 'replace') { await rename(tmp, target); return target; }
    const candidates = policy === 'fail' ? [target] : Array.from({ length: 1000 }, (_, i) => i === 0 ? target : numbered(target, i));
    for (const c of candidates) {
      try { await link(tmp, c); await unlink(tmp); return c; }
      catch (e) { if (!isErr(e, 'EEXIST')) throw e; }
    }
    throw new AppError('FILE_EXISTS', { name: basename(target) });
  }
}

// "name (n).ext" within MAX_NAME_BYTES; the extension is kept only if at least one character of the stem fits before it.
function numbered(target: string, n: number): string {
  const name = basename(target);
  const counter = ` (${n})`;
  const ext = extname(name);
  const stem = truncateBytes(name.slice(0, name.length - ext.length), MAX_NAME_BYTES - Buffer.byteLength(counter + ext));
  const numberedName = stem.length > 0
    ? `${stem}${counter}${ext}`
    : `${truncateBytes(name, MAX_NAME_BYTES - Buffer.byteLength(counter))}${counter}`;
  return join(dirname(target), numberedName);
}
