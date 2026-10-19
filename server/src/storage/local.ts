import { constants, createWriteStream, linkSync, lstatSync, renameSync, unlinkSync, type Stats } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readdir, rm, truncate, unlink, utimes } from 'node:fs/promises';
import { basename, dirname, extname, join, posix } from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { CollisionPolicy, Entry, HomeUsage, LargeFolder, OpenUpload, ThumbSize, TrashItem } from '@files/shared';
import { AppError } from '../errors.ts';
import { normalizeHomePath, resolveInRoot } from './resolveInRoot.ts';
import { RangeNotSatisfiable, type ByteRange, type Revision, type StorageBackend, type WriteOptions } from './backend.ts';
import { lookupMime } from './mime.ts';
import type { Db } from '../db.ts';
import { deletePathRefs, deleteTrashRefs, movePathRefs, restoreTrashRefs, type PathTable, type TrashTable } from './pathRefs.ts';
import { recordRecent } from './recent.ts';
import { indexedItem, indexItems, largestFolders, replaceIndex, searchIndex, type IndexedItem } from './nameIndex.ts';
import type { ThumbnailCache } from './thumbnails.ts';
import type { DiskHold, DiskReserve } from './diskReserve.ts';
import { uploadBusy, withUpload } from './uploadLocks.ts';

export const INTERNAL = '.files';
export const TEMP_NAME = /^\.[0-9a-f]{16}\.upload$/;
const TRASH_ID = /^[0-9a-f]{32}$/;
const VERSION_ID = /^[0-9a-f]{32}$/;
export const UPLOAD_ID = /^[0-9a-f]{32}$/;
const DAY_MS = 86_400_000;
/** An upload expires this long after it was created or last received bytes. */
export const UPLOAD_TTL_MS = DAY_MS;
/** A file-request visitor's upload expires after this much idle time instead (#364): its announced bytes cost them nothing. */
export const VISITOR_UPLOAD_TTL_MS = 15 * 60_000;
type TrashRow = { id: string; original_path: string; type: 'file' | 'directory'; size: number; deleted_at: string };
type VersionRow = { id: string; path: string; size: number; modified: string };
type UploadRow = { id: string; source: string; path: string; length: number; received: number; on_collision: CollisionPolicy; expires_at: string };
/** What HEAD reports; `entry` is set once the bytes have been placed at their target. */
export type UploadState = { id: string; offset: number; length: number; expiresAt: string; entry?: Entry };
/**
 * Where a complete upload goes instead of the path it was opened with (a file request, #217): another home path (placed
 * by rename like any upload), or a write into another backend (a cloud folder), after which the staged bytes are dropped.
 * `placed` runs with the name the file got, inside the placing transaction for a home path and before the drop for a
 * write, so the upload never counts as neither open nor placed.
 */
export type UploadPlacement = { placed: (name: string) => void } & ({ path: string } | { write: (body: Readable, length: number) => Promise<Entry> });
/**
 * A resumable upload to open. `source` is where it goes: `home` is placed in this home at `path`; any other source is
 * only staged here and placed by the caller's `UploadPlacement` (a file request into a cloud folder, #217).
 */
export type CreateUpload = { source: string; path: string; length: number; onCollision: CollisionPolicy; maxBytes: number;
  /** A file-request visitor's upload (#364): expires after `VISITOR_UPLOAD_TTL_MS` idle. */
  visitor?: boolean };

// Restore and purge of one member's trash run one at a time, so a purge never removes bytes a restore is moving; quota
// reservations are taken and released under the same lock (#197). Not reentrant: nothing under it may take it again.
const userLocks = new Map<string, Promise<unknown>>();
function underUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined); // handled: the caller gets the error from `run`
  userLocks.set(userId, tail);
  void tail.then(() => { if (userLocks.get(userId) === tail) userLocks.delete(userId); });
  return run;
}

// Quota taken by direct writes and copies in flight (#197), per member: the bytes each may still add and the path its
// bytes are staged at. A staged path is left out of the disk walk while its reservation counts instead, so a write is
// counted exactly once however far it has got. Taken and released under the member's lock; the app runs as one process.
type Reservation = { bytes: number; staging: string };
const inFlight = new Map<string, Set<Reservation>>();
const inFlightOf = (userId: string) => inFlight.get(userId) ?? new Set<Reservation>();
/** A write of unknown length asks the disk reserve again after this many bytes (#320): others may be writing too. */
const DISK_RECHECK_BYTES = 16 * 1024 ** 2;

// Bytes of the regular files in a tree (0 for anything that is gone or in `skip`); symlinks are neither followed nor counted.
export async function treeSize(abs: string, skip?: ReadonlySet<string>): Promise<number> {
  if (skip?.has(abs)) return 0;
  const st = await lstat(abs).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) return undefined; throw e; });
  if (!st) return 0;
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let sum = 0;
  for (const name of await readdir(abs)) sum += await treeSize(join(abs, name), skip);
  return sum;
}
const MAX_NAME_BYTES = 255;
const MAX_LIMIT = 1000;
const isErr = (e: unknown, code: string) => (e as NodeJS.ErrnoException).code === code;
// Inode in the tag: a replace with identical size and mtime still changes it. Keyed, so a grantee or a link's visitor
// cannot recover the owner's inode from it (#279).
const etagOf = (key: Buffer, st: { ino: number; size: number; mtimeMs: number }) =>
  `"${createHmac('sha256', key).update(`${st.ino}|${st.size}|${Math.floor(st.mtimeMs)}`).digest('base64url').slice(0, 27)}"`;

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

// A listed name must round-trip through normalizeHomePath unchanged, else it could not be addressed again.
function addressable(name: string): boolean {
  if (name.includes('\uFFFD') || TEMP_NAME.test(name)) return false; // U+FFFD: invalid UTF-8 on disk
  try { return normalizeHomePath('/' + name) === '/' + name; }
  catch { return false; } // handled: unaddressable on-disk name is skipped
}

export function truncateBytes(s: string, max: number): string {
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
 * `versions`: how many versions of one file are kept, and how many bytes they may hold together (#154).
 * `disk` is the shard's disk reserve (#320); every home the app serves has it, only the expiry jobs, the reindex
 * command and unit tests (which add no bytes) go without.
 */
export type HomeIndex = { db: Db; userId: string; pathTables: readonly PathTable[]; trashTables: readonly TrashTable[];
  thumbs?: ThumbnailCache; disk?: DiskReserve; versions: { maxCount: number; maxBytes: number }; etagKey: Buffer };

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

/**
 * Every file and folder beneath the folder `abs` that a listing would show, with paths relative to it (`/a/b`): no
 * symlinks, no temp files, no unaddressable names, and no internal area when `abs` is a home root.
 */
export async function walkTree(abs: string, isHome: boolean): Promise<IndexedItem[]> {
  const out: IndexedItem[] = [];
  const visit = async (dir: string, rel: string) => {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if ((isHome && rel === '' && d.name === INTERNAL) || !(d.isFile() || d.isDirectory()) || !addressable(d.name)) continue;
      const st = await lstat(join(dir, d.name)).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) return undefined; throw e; });
      if (!st || !(st.isFile() || st.isDirectory())) continue; // gone or replaced by something else since readdir
      out.push(indexedItem(`${rel}/${d.name}`, st));
      if (st.isDirectory()) await visit(join(dir, d.name), `${rel}/${d.name}`);
    }
  };
  await visit(abs, '');
  return out;
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
    const n = normalizeHomePath(p);
    if (n === `/${INTERNAL}` || n.startsWith(`/${INTERNAL}/`)) throw new AppError('PATH_INVALID');
    if (n !== '/' && TEMP_NAME.test(basename(n))) throw new AppError('PATH_INVALID');
    await mkdir(this.root, { recursive: true });
    return resolveInRoot(this.root, n);
  }

  private entry(userPath: string, st: { isDirectory(): boolean; size: number; mtime: Date }): Entry {
    const path = normalizeHomePath(userPath);
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

  /** SHA-256 of the file as it lies on disk, read as a stream (verification of transfers, #152). */
  async digest(p: string): Promise<string> {
    const { stream } = await this.read(p);
    const hash = createHash('sha256');
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }

  /** The kept versions of a file (#154), oldest first; the file itself is not one of them. */
  async revisions(p: string): Promise<Revision[]> {
    const n = normalizeHomePath(p);
    await this.statFile(n);
    return this.liveVersions(n).map((v) => ({ id: v.id, modified: v.modified, size: v.size }));
  }

  /** The bytes of one kept version of the file at `p`; a version of any other file is NOT_FOUND. */
  async readRevision(p: string, id: string): Promise<Awaited<ReturnType<StorageBackend['read']>>> {
    const n = normalizeHomePath(p);
    await this.abs(n);
    const row = this.versionRow(n, id);
    if (!row) throw new AppError('NOT_FOUND');
    const fh = await open(await this.versionBytes(id), constants.O_RDONLY | constants.O_NOFOLLOW).catch((e) => {
      if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND', undefined, { cause: e });
      throw e;
    });
    try {
      const size = (await fh.stat()).size;
      const name = basename(n);
      return { entry: { name, path: n, type: 'file', size, modified: row.modified, mime: lookupMime(name) },
        stream: fh.createReadStream({ autoClose: true }), etag: `"v-${id}"` };
    } catch (e) {
      await fh.close();
      throw e;
    }
  }

  /**
   * The version becomes the file's content again, and the content it replaces is kept as a version, in one transaction
   * (renames only: the version's bytes move into place, nothing is copied).
   */
  restoreRevision(p: string, id: string): Promise<Entry> { return this.restoreRevisionImpl(p, id).catch(rethrowMapped); }

  private async restoreRevisionImpl(p: string, id: string): Promise<Entry> {
    const n = normalizeHomePath(p);
    const target = await this.abs(n);
    if (!this.versionRow(n, id)) throw new AppError('NOT_FOUND');
    await this.statFile(n);
    const src = await this.versionBytes(id);
    const versions = await this.internalDir('versions');
    const { db, userId } = this.index;
    this.atomically((fs) => {
      if (!this.versionRow(n, id)) throw new AppError('NOT_FOUND'); // pruned meanwhile
      this.keepVersion(fs, versions, target, n);
      fs.rename(src, target);
      db.prepare('DELETE FROM versions WHERE id = ? AND user_id = ?').run(id, userId);
      recordRecent(db, userId, n, 'file');
      this.indexPlaced(n, target);
    });
    for (const d of [dirname(target), versions]) await syncDir(d);
    await this.pruneVersions(n);
    await this.forgetThumbs(n);
    return this.statImpl(n);
  }

  // A file at `n`, else NOT_FOUND or IS_A_DIRECTORY.
  private async statFile(n: string): Promise<void> {
    const st = await lstat(await this.abs(n)).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND'); throw e; });
    if (st.isDirectory()) throw new AppError('IS_A_DIRECTORY');
    if (!st.isFile()) throw new AppError('NOT_FOUND');
  }

  private liveVersions(n: string): VersionRow[] {
    return this.index.db.prepare(`SELECT id, path, size, modified FROM versions WHERE user_id = ? AND path = ? AND trash_id IS NULL
      ORDER BY created_at, rowid`).all(this.index.userId, n) as VersionRow[];
  }

  private versionRow(n: string, id: string): VersionRow | undefined {
    if (!VERSION_ID.test(id)) return undefined;
    return this.index.db.prepare('SELECT id, path, size, modified FROM versions WHERE id = ? AND user_id = ? AND path = ? AND trash_id IS NULL')
      .get(id, this.index.userId, n) as VersionRow | undefined;
  }

  // The bytes of a version, through the same resolver as every other path; only this class names the internal area.
  private async versionBytes(id: string): Promise<string> {
    if (!VERSION_ID.test(id)) throw new AppError('NOT_FOUND');
    await this.internalDir('versions');
    return resolveInRoot(this.root, `/${INTERNAL}/versions/${id}`);
  }

  // Inside the transaction of an overwrite: the file at `abs` (user path `rel`) moves into the versions, with its row.
  // Nothing is kept when no file is there yet.
  private keepVersion(fs: FsSteps, versions: string, abs: string, rel: string): void {
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st?.isFile()) return;
    const id = randomBytes(16).toString('hex');
    fs.rename(abs, join(versions, id));
    this.index.db.prepare('INSERT INTO versions (id, user_id, path, size, modified, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, this.index.userId, rel, st.size, st.mtime.toISOString(), new Date().toISOString());
  }

  // After a version was added: the newest ones are kept while they fit the caps (count and bytes together); from the
  // first one that does not fit, every older one goes. Bytes first, then the row, so a failure leaves the row to retry.
  private async pruneVersions(n: string): Promise<void> {
    const { db, userId, versions: cap } = this.index;
    let count = 0; let bytes = 0; let full = false;
    for (const v of this.liveVersions(n).reverse()) {
      if (!full && count < cap.maxCount && bytes + v.size <= cap.maxBytes) { count++; bytes += v.size; continue; }
      full = true;
      await rm(await this.versionBytes(v.id), { force: true });
      db.prepare('DELETE FROM versions WHERE id = ? AND user_id = ?').run(v.id, userId);
    }
  }

  private async thumbnailImpl(p: string, size: ThumbSize): Promise<Readable | null> {
    const { thumbs, userId } = this.index;
    if (!thumbs) throw new Error('this LocalBackend was built without a thumbnail cache');
    const a = await this.abs(p);
    const st = await lstat(a).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND'); throw e; });
    if (st.isDirectory()) throw new AppError('IS_A_DIRECTORY');
    if (!st.isFile()) throw new AppError('NOT_FOUND');
    return thumbs.get({ userId, path: normalizeHomePath(p), abs: a, etag: etagOf(this.index.etagKey, st), mime: lookupMime(basename(a)) }, size);
  }

  // After a write, move or delete has landed: the thumbnails of the paths it touched (and beneath them) go. A stale one
  // would never be served anyway (the ETag check), so this only frees the cache at once.
  private async forgetThumbs(...paths: string[]): Promise<void> {
    for (const p of new Set(paths)) await this.index.thumbs?.forget(this.index.userId, p);
  }

  // Inside the transaction of a write: index rows for the item now at `rel` (absolute `abs`), for the folders above it
  // that were created on the way (folder upload, restore, mkdir) and for `beneath`, the tree a copied or restored folder
  // brought along (paths relative to the item). A move brings its rows along through the PATH_TABLES cascade and only
  // needs the item itself, whose name may have changed.
  private indexPlaced(rel: string, abs: string, beneath: readonly IndexedItem[] = []): void {
    const { db, userId } = this.index;
    const above: IndexedItem[] = [];
    for (let r = posix.dirname(rel), a = dirname(abs); r !== '/'; r = posix.dirname(r), a = dirname(a)) above.push(indexedItem(r, lstatSync(a)));
    indexItems(db, userId, above, 'keep');
    indexItems(db, userId, [indexedItem(rel, lstatSync(abs)), ...beneath.map((b) => ({ ...b, path: rel + b.path }))]);
  }

  /** Name search over the member's index (#145): what the app last wrote, without touching the disk. */
  async search(query: string, limit: number): Promise<Entry[]> {
    return searchIndex(this.index.db, this.index.userId, query, limit);
  }

  /**
   * Replaces the member's name index with what is on disk (recovery after changes outside the app). The walk runs
   * before the transaction, so a write that lands during the walk may be missed until the next rebuild.
   */
  async rebuildNameIndex(): Promise<number> {
    const items = await walkTree(await this.abs('/'), true).catch(rethrowMapped);
    this.index.db.transaction(() => replaceIndex(this.index.db, this.index.userId, items)).immediate();
    return items.length;
  }

  // The internal area goes through the same resolver; only this class may name it.
  private async internalDir(name: 'trash' | 'tmp' | 'uploads' | 'versions'): Promise<string> {
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
    const nf = normalizeHomePath(from); const nt = normalizeHomePath(to);
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
    // The trash row first: rows that go to the trash with the item (versions) point at it.
    db.prepare('INSERT INTO trash (id, user_id, original_path, type, size, deleted_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, userPath, st.isDirectory() ? 'directory' : 'file', st.isDirectory() ? treeBytes : st.size, new Date().toISOString());
    deletePathRefs(db, pathTables, userId, userPath, id);
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
      this.indexPlaced(rel, target);
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
    // The copy adds the source's bytes (#156), reserved until they are placed (#197); "replace" sends the item in the
    // way to the trash, which still counts. The disk reserve holds them likewise (#320).
    const { granted, diskAllowed, release } = await this.reserve(await treeSize(e.src), stage);
    try {
      await copyTree(e.src, stage);
      // The source may have grown while it was copied.
      const copied = await treeSize(stage);
      if (copied > granted) throw new AppError('QUOTA_EXCEEDED');
      if (copied > diskAllowed) throw new AppError('STORAGE_FULL');
      const beneath = e.type === 'directory' ? await walkTree(stage, false) : [];
      const replacedSize = policy === 'replace' ? await treeSize(e.dst) : 0;
      const placed = this.atomically((fs) => {
        const target = this.claim(fs, trash, e.dst, e.nt, policy, replacedSize);
        fs.rename(stage, target);
        const rel = join(dirname(e.nt), basename(target));
        recordRecent(this.index.db, this.index.userId, rel, e.type);
        this.indexPlaced(rel, target, beneath);
        return rel;
      });
      for (const d of new Set([dirname(e.dst), trash])) await syncDir(d);
      await this.forgetThumbs(placed);
      return await this.statImpl(placed);
    } catch (err) {
      await rm(stage, { recursive: true, force: true });
      throw err;
    } finally {
      await release();
    }
  }

  private async deleteImpl(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) throw new AppError('VALIDATION');
    const norm = [...new Set(paths.map(normalizeHomePath))];
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
    // Trashed bytes count already, but the trash empties itself; a restore keeps them for good, so it needs room (#156).
    if (row.size > await this.remainingQuota()) throw new AppError('QUOTA_EXCEEDED');
    // Likewise the disk reserve (#320): the trash would free these bytes, the restored file never does.
    if (this.index.disk && row.size > await this.index.disk.left()) throw new AppError('STORAGE_FULL');
    const src = await this.trashBytes(id);
    const trash = await this.internalDir('trash');
    const nt = normalizeHomePath(row.original_path);
    const dst = await this.abs(nt); // refuses symlinks and files on the way, like any user path
    await mkdir(dirname(dst), { recursive: true }).catch((e) => {
      if (isErr(e, 'ENOTDIR') || isErr(e, 'EEXIST')) throw new AppError('NOT_A_DIRECTORY', undefined, { cause: e });
      throw e;
    });
    const replacedSize = policy === 'replace' ? await treeSize(dst) : 0;
    const beneath = row.type === 'directory' ? await walkTree(src, false) : [];
    const placed = this.atomically((fs) => {
      const target = this.claim(fs, trash, dst, nt, policy, replacedSize);
      fs.rename(src, target);
      const rel = join(dirname(nt), basename(target));
      // The target is free here, so rows still pointing there are stale (as in a move) and give way to the item's own.
      deletePathRefs(this.index.db, this.index.pathTables, this.index.userId, rel);
      // Rows that went to the trash with the item (versions, tags) are live again where it lands, before the row goes.
      restoreTrashRefs(this.index.db, this.index.trashTables, id, nt, rel);
      this.index.db.prepare('DELETE FROM trash WHERE id = ? AND user_id = ?').run(id, this.index.userId);
      recordRecent(this.index.db, this.index.userId, rel, row.type);
      this.indexPlaced(rel, target, beneath);
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
        // The versions kept with the item go first: their rows stay with the trash row until it is deleted below.
        for (const v of db.prepare('SELECT id FROM versions WHERE trash_id = ? AND user_id = ?').pluck().all(id, userId) as string[]) {
          await rm(await this.versionBytes(v), { force: true });
        }
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

  // Quota minus the bytes under the home, staged bytes of writes in flight left out; Infinity without a quota. The walk
  // is async, so callers that must not race run it under the member's lock and subtract `reserved()` right after it.
  private async freeBeforeReservations(): Promise<number> {
    const quota = this.quotaBytes();
    if (quota === null) return Infinity;
    await mkdir(this.root, { recursive: true });
    const skip = new Set([...inFlightOf(this.index.userId)].map((r) => r.staging));
    return quota - await treeSize(await resolveInRoot(this.root, '/'), skip);
  }

  /**
   * Takes `bytes` of the member's free space for a write or copy staged at `staging` (#197), or, without a declared
   * size, all that is left. Checked and taken under the member's lock, so writes running together never share the same
   * free bytes. Then the same bytes are held against the shard's disk reserve (#320), STORAGE_FULL if they do not fit.
   * Returns the bytes granted by the quota and by the disk, the disk hold (to count what has been written; none without
   * a reserve) and a release to call once the bytes are placed or dropped.
   */
  private async reserve(bytes: number | undefined, staging: string): Promise<{ granted: number; diskAllowed: number;
    diskHold?: DiskHold; release: () => Promise<void> }> {
    const quota = await this.reserveQuota(bytes, staging);
    if (!this.index.disk) return { ...quota, diskAllowed: Infinity };
    let disk: Awaited<ReturnType<DiskReserve['hold']>>;
    try { disk = await this.index.disk.hold(bytes); }
    catch (e) { await quota.release(); throw e; }
    return { granted: quota.granted, diskAllowed: disk.allowed, diskHold: disk.hold,
      release: async () => { disk.release(); await quota.release(); } };
  }

  private reserveQuota(bytes: number | undefined, staging: string): Promise<{ granted: number; release: () => Promise<void> }> {
    const userId = this.index.userId;
    return underUserLock(userId, async () => {
      const free = await this.freeBeforeReservations();
      if (free === Infinity) return { granted: Infinity, release: async () => {} };
      const left = Math.max(0, free - this.reserved());
      if (bytes !== undefined && bytes > left) throw new AppError('QUOTA_EXCEEDED');
      const r: Reservation = { bytes: bytes ?? left, staging };
      inFlight.set(userId, inFlightOf(userId).add(r));
      // Released under the lock too: a walk in progress has either seen the placed bytes or still counts the reservation.
      const release = () => underUserLock(userId, async () => {
        const set = inFlightOf(userId);
        set.delete(r);
        if (set.size === 0) inFlight.delete(userId);
      });
      return { granted: r.bytes, release };
    });
  }

  /** The member's quota in bytes as the admin set it (#156), or null for none. */
  quotaBytes(): number | null {
    const quota = this.index.db.prepare('SELECT quota_bytes FROM users WHERE id = ?').pluck().get(this.index.userId) as number | null | undefined;
    return quota ?? null;
  }

  /**
   * Bytes under the home by kind (#156); every one of them counts towards the quota. Measured on disk like the quota
   * check, so the overview shows exactly what the check sees. Anything in the internal area besides the trash and the
   * versions is staging: tus uploads in progress and interrupted copies.
   */
  async usage(): Promise<HomeUsage> {
    const usage = { files: 0, trash: 0, versions: 0, uploads: 0 };
    const root = await this.abs('/');
    const names = (dir: string) => readdir(dir).catch((e: unknown) => { if (isErr(e, 'ENOENT')) return []; throw e; });
    for (const name of await names(root)) if (name !== INTERNAL) usage.files += await treeSize(join(root, name));
    const area = await resolveInRoot(this.root, `/${INTERNAL}`);
    for (const name of await names(area)) {
      const bytes = await treeSize(join(area, name));
      if (name === 'trash') usage.trash += bytes; else if (name === 'versions') usage.versions += bytes; else usage.uploads += bytes;
    }
    return { ...usage, total: usage.files + usage.trash + usage.versions + usage.uploads };
  }

  /** The home's largest folders (#156), from the name index. */
  largestFolders(limit: number): LargeFolder[] { return largestFolders(this.index.db, this.index.userId, limit); }

  // What open tus uploads other than `exceptUpload` have yet to send, plus what direct writes and copies in flight hold.
  // An expired upload holds nothing, even before the expiry job removes it, unless it is receiving bytes right now (#364).
  private reserved(exceptUpload?: string): number {
    let held = 0;
    for (const r of inFlightOf(this.index.userId)) held += r.bytes;
    const rows = this.index.db.prepare('SELECT id, length - received AS rest, expires_at FROM uploads WHERE user_id = ? AND id IS NOT ?')
      .all(this.index.userId, exceptUpload ?? null) as { id: string; rest: number; expires_at: string }[];
    const now = new Date().toISOString();
    for (const r of rows) if (r.expires_at > now || uploadBusy(r.id)) held += r.rest;
    return held;
  }

  // A file-request visitor's upload (#364), staged in this home: its rest never holds the disk.
  private isVisitorUpload(id: string): boolean {
    return this.index.db.prepare('SELECT 1 FROM file_request_uploads WHERE upload_id = ?').get(id) !== undefined;
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
  createUpload(u: CreateUpload): Promise<UploadState> {
    return this.createUploadImpl(u).catch(rethrowMapped);
  }

  private async createUploadImpl(u: CreateUpload) {
    if (u.length > u.maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');
    const nt = normalizeHomePath(u.path);
    if (nt === '/') throw new AppError('PATH_INVALID');
    // An upload for another source (a file request into a cloud folder) is only staged here: its path is not in this home.
    if (u.source === 'home') {
      const target = await this.abs(nt);
      const st = await lstat(target).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) return undefined; throw e; });
      if (st?.isDirectory() && u.onCollision !== 'keep-both') throw new AppError('IS_A_DIRECTORY');
      if (st && u.onCollision === 'fail') throw new AppError('FILE_EXISTS', { name: basename(target) });
    }
    const { db, userId } = this.index;
    const id = randomBytes(16).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (u.visitor ? VISITOR_UPLOAD_TTL_MS : UPLOAD_TTL_MS)).toISOString();
    // Walk, reservation check and insert under the member's lock (shared with direct writes and copies, #197) and one
    // write lock, so two uploads or writes started at once cannot both take the last bytes.
    // The disk reserve (#320) is checked under its own lock too: every member's open uploads count against the one disk.
    await underUserLock(userId, async () => {
      const free = await this.freeBeforeReservations();
      const insert = (diskLeft: number) => db.transaction(() => {
        if (free !== Infinity && u.length > free - this.reserved()) throw new AppError('QUOTA_EXCEEDED');
        if (u.length > diskLeft) throw new AppError('STORAGE_FULL');
        db.prepare(`INSERT INTO uploads (id, user_id, source, path, length, received, on_collision, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(id, userId, u.source, nt, u.length, u.onCollision, now.toISOString(), expiresAt);
      }).immediate();
      const disk = this.index.disk;
      if (disk) await disk.serialized(async () => insert(await disk.left()));
      else insert(Infinity);
    });
    try {
      const fh = await open(await this.uploadBytes(id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
      await fh.close();
    } catch (e) {
      db.prepare('DELETE FROM uploads WHERE id = ? AND user_id = ?').run(id, userId);
      throw e;
    }
    return { id, offset: 0, length: u.length, expiresAt };
  }

  /**
   * The member's own open uploads into this home, oldest first (#233): what the upload panel offers to resume or discard
   * after a reload. A visitor's upload through one of the member's file requests is staged here too, but is not theirs.
   */
  openUploads(): OpenUpload[] {
    const rows = this.index.db.prepare(`SELECT id, path, length, received, expires_at FROM uploads
      WHERE user_id = ? AND source = 'home' AND id NOT IN (SELECT upload_id FROM file_request_uploads WHERE upload_id IS NOT NULL)
      ORDER BY created_at, id`).all(this.index.userId) as Pick<UploadRow, 'id' | 'path' | 'length' | 'received' | 'expires_at'>[];
    return rows.map((r) => ({ id: r.id, path: r.path, length: r.length, offset: r.received, expiresAt: r.expires_at }));
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
  async appendUpload(id: string, offset: number, body: Readable, declared?: number,
    placement?: () => Promise<UploadPlacement>): Promise<UploadState> {
    this.ownUpload(id);
    return withUpload(id, () => this.appendImpl(id, offset, body, declared, placement)).catch(rethrowMapped);
  }

  private async appendImpl(id: string, offset: number, body: Readable, declared?: number,
    placement?: () => Promise<UploadPlacement>): Promise<UploadState> {
    const row = this.ownUpload(id);
    if (offset !== row.received) throw new AppError('OFFSET_MISMATCH', { offset: row.received });
    const rest = row.length - row.received;
    if (declared !== undefined && declared > rest) { await this.dropUpload(id); throw new AppError('SIZE_MISMATCH'); }
    if (rest > 0 && rest > await this.remainingQuota(id)) throw new AppError('QUOTA_EXCEEDED');
    const visitor = this.isVisitorUpload(id);
    const disk = this.index.disk;
    // A member's rest was promised at creation, but the disk may have filled up since (#320). A visitor's announced
    // bytes hold nothing (#364), not even while this PATCH runs, since a body that stalls or trickles in would keep any
    // hold for as long as it likes: like a write of unknown length, each window of up to 16 MiB must fit what is left
    // before its bytes are written, so a refused PATCH ends with what arrived recorded.
    const firstWindow = Math.min(rest, declared ?? rest, DISK_RECHECK_BYTES);
    if (rest > 0 && disk && (visitor ? firstWindow > await disk.left() : rest > await disk.left(id))) throw new AppError('STORAGE_FULL');
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
    // A visitor's PATCH may write up to `checked` without asking the disk reserve again.
    let checked = visitor && disk ? firstWindow : Infinity;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        const from = written;
        written += chunk.length;
        if (written > rest) { over = true; return cb(new AppError('SIZE_MISMATCH')); }
        if (!disk || written <= checked) return cb(null, chunk);
        // The checked window is used up: the next one, these bytes included, must fit before they are written.
        const next = Math.max(written, Math.min(rest, from + DISK_RECHECK_BYTES));
        disk.left().then((left) => {
          if (next - from > left) return cb(new AppError('STORAGE_FULL'));
          checked = next;
          cb(null, chunk);
        }, cb);
      },
    });
    await pipeline(body, limiter, createWriteStream(file, { flags: 'r+', start: row.received }))
      .catch((e: unknown) => { failure = e; }); // handled: what arrived is fsynced and recorded below, then the error is rethrown
    const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let size: number;
    try { await fh.sync(); size = (await fh.stat()).size; } finally { await fh.close(); }
    if (over) { await this.dropUpload(id); throw new AppError('SIZE_MISMATCH'); }
    const expiresAt = new Date(Date.now() + (visitor ? VISITOR_UPLOAD_TTL_MS : UPLOAD_TTL_MS)).toISOString();
    this.index.db.prepare('UPDATE uploads SET received = ?, expires_at = ? WHERE id = ? AND user_id = ?').run(size, expiresAt, id, this.index.userId);
    if (failure !== undefined) throw failure;
    const state: UploadState = { id, offset: size, length: row.length, expiresAt };
    if (size < row.length) return state;
    const complete = { ...row, received: size };
    if (!placement) return { ...state, entry: await this.placeUpload(complete, row.on_collision) };
    // Resolved only now, so the target is where it is at the end (a moved folder, a revoked request).
    const p = await placement();
    if ('path' in p) return { ...state, entry: await this.placeUpload({ ...complete, path: p.path }, row.on_collision, p.placed) };
    const src = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stream = src.createReadStream({ autoClose: true });
    // A write that fails leaves the bytes staged, so the next PATCH places them again; the stream closes the handle either way.
    let entry: Entry;
    try { entry = await p.write(stream, size); } finally { stream.destroy(); }
    p.placed(entry.name);
    await this.dropUpload(id);
    return { ...state, entry };
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
      if (uploadBusy(id)) continue;
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
  private async placeUpload(row: UploadRow, policy: CollisionPolicy, onPlaced?: (name: string) => void): Promise<Entry> {
    // Staged for another source: only its caller's `UploadPlacement` places it (a file request into a cloud folder).
    if (row.source !== 'home' && !onPlaced) throw new AppError('NOT_SUPPORTED');
    const nt = normalizeHomePath(row.path);
    const target = await this.abs(nt);
    await mkdir(dirname(target), { recursive: true }).catch((e) => {
      if (isErr(e, 'ENOTDIR') || isErr(e, 'EEXIST')) throw new AppError('NOT_A_DIRECTORY', undefined, { cause: e });
      throw e;
    });
    const st = await lstat(target).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) return undefined; throw e; });
    if (st?.isDirectory() && policy !== 'keep-both') throw new AppError('IS_A_DIRECTORY');
    const staged = await this.uploadBytes(row.id);
    const versions = await this.internalDir('versions');
    const { db, userId } = this.index;
    const placed = this.atomically((fs) => {
      let final: string;
      if (policy === 'replace') { this.keepVersion(fs, versions, target, nt); fs.rename(staged, target); final = target; }
      else final = fs.linkInto(staged, policy === 'fail' ? [target] : Array.from({ length: 1000 }, (_, i) => i === 0 ? target : numbered(target, i)));
      db.prepare('DELETE FROM uploads WHERE id = ? AND user_id = ?').run(row.id, userId);
      onPlaced?.(basename(final));
      recordRecent(db, userId, join(dirname(nt), basename(final)), 'file');
      this.indexPlaced(join(dirname(nt), basename(final)), final);
      return final;
    });
    for (const d of new Set([dirname(target), dirname(staged), versions])) await syncDir(d);
    const rel = join(dirname(nt), basename(placed));
    if (policy === 'replace') await this.pruneVersions(rel);
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
    const base = normalizeHomePath(p);
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
      return { entry: this.entry(p, st), stream, etag: etagOf(this.index.etagKey, st), ...(range ? { range } : {}) };
    } catch (e) {
      await fh.close();
      throw e;
    }
  }

  private async mkdirImpl(p: string): Promise<Entry> {
    const a = await this.abs(p);
    await mkdir(dirname(a), { recursive: true });
    await mkdir(a).catch((e) => { if (isErr(e, 'EEXIST')) throw new AppError('FILE_EXISTS'); throw e; });
    this.index.db.transaction(() => this.indexPlaced(normalizeHomePath(p), a)).immediate();
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
      if (opts.ifMatch !== undefined && (!s?.isFile() || etagOf(this.index.etagKey, s) !== opts.ifMatch)) throw new AppError('PRECONDITION_FAILED');
    };
    checkIfMatch(st);
    const tmp = join(dir, `.${randomBytes(8).toString('hex')}.upload`);
    // The declared size is reserved before a byte is read (#197); without one the write may fill what is left.
    const { granted: quotaLeft, diskAllowed, diskHold, release } = await this.reserve(opts.size, tmp);
    try { return await this.writeReserved(p, body, opts, { target, dir, tmp, quotaLeft, diskAllowed, diskHold, current, checkIfMatch }); }
    finally { await release(); }
  }

  private async writeReserved(p: string, body: Readable, opts: WriteOptions, w: { target: string; dir: string; tmp: string;
    quotaLeft: number; diskAllowed: number; diskHold?: DiskHold; current: () => Promise<Stats | undefined>;
    checkIfMatch: (s: Stats | undefined) => void }): Promise<Entry> {
    const { target, dir, tmp, quotaLeft, diskAllowed, diskHold, current, checkIfMatch } = w;
    const disk = this.index.disk;
    let written = 0;
    let checkedAt = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        if (diskHold) diskHold.written = written;
        if (written > opts.maxBytes) return cb(new AppError('PAYLOAD_TOO_LARGE'));
        if (written > quotaLeft) return cb(new AppError('QUOTA_EXCEEDED'));
        if (written > diskAllowed) return cb(new AppError('STORAGE_FULL'));
        if (opts.size !== undefined && written > opts.size) return cb(new AppError('SIZE_MISMATCH'));
        // Without a declared size nothing was held, so other writes may take the same free bytes meanwhile (#320).
        if (opts.size === undefined && disk && written - checkedAt >= DISK_RECHECK_BYTES) {
          checkedAt = written;
          return void disk.left().then((left) => cb(left < 0 ? new AppError('STORAGE_FULL') : null, chunk), cb);
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, limiter, createWriteStream(tmp, { flags: 'wx' }));
      if (opts.size !== undefined && written !== opts.size) throw new AppError('SIZE_MISMATCH');
      if (opts.modified !== undefined) { const m = new Date(opts.modified); await utimes(tmp, m, m); }
      const fh = await open(tmp, 'r+'); await fh.sync(); await fh.close();
      checkIfMatch(await current());
      const { db, userId } = this.index;
      let rel: string;
      if (opts.onCollision === 'replace') {
        // The content being replaced is kept as a version, in the transaction that puts the new bytes in place.
        rel = normalizeHomePath(p);
        const versions = await this.internalDir('versions');
        this.atomically((fs) => {
          this.keepVersion(fs, versions, target, rel);
          fs.rename(tmp, target);
          recordRecent(db, userId, rel, 'file');
          this.indexPlaced(rel, target);
        });
        // The rename lives in the directory entry; without this a crash can lose the file after we answered 201.
        for (const d of [dir, versions]) await syncDir(d);
        await this.pruneVersions(rel);
      } else {
        const finalPath = await this.place(tmp, target, opts.onCollision);
        await syncDir(dir);
        rel = join(dirname(normalizeHomePath(p)), basename(finalPath));
        db.transaction(() => { recordRecent(db, userId, rel, 'file'); this.indexPlaced(rel, finalPath); }).immediate();
      }
      await this.forgetThumbs(rel);
      return this.statImpl(rel);
    } catch (e) {
      await unlink(tmp).catch((u) => { if (!isErr(u, 'ENOENT')) throw u; }); // handled: tmp may not exist yet
      throw e;
    }
  }

  // "fail" and "keep both": a hard link refuses a taken name atomically. "replace" goes through `keepVersion`.
  private async place(tmp: string, target: string, policy: Exclude<CollisionPolicy, 'replace'>): Promise<string> {
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
