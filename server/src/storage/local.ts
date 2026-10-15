import { constants, createWriteStream, lstatSync, renameSync } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CollisionPolicy, Entry } from '@files/shared';
import { AppError } from '../errors.ts';
import { normalizeUserPath, resolveInRoot } from './resolveInRoot.ts';
import { RangeNotSatisfiable, type ByteRange, type StorageBackend, type WriteOptions } from './backend.ts';
import { lookupMime } from './mime.ts';
import type { Db } from '../db.ts';
import { deletePathRefs, movePathRefs, type PathTable } from './pathRefs.ts';

export const INTERNAL = '.files';
export const TEMP_NAME = /^\.[0-9a-f]{16}\.upload$/;
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

/** The database side of a home: path-dependent rows and trash rows change in the same transaction as the files. */
export type HomeIndex = { db: Db; userId: string; pathTables: readonly PathTable[] };

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

  // The internal area goes through the same resolver; only this class may name it.
  private async internalDir(name: 'trash' | 'tmp'): Promise<string> {
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
    return { nf, nt, src, dst };
  }

  // Inside the transaction: the absolute path the item may take. "replace" sends the existing item to the trash.
  private claim(fs: FsSteps, trash: string, dst: string, userPath: string, policy: CollisionPolicy): string {
    if (!lstatSync(dst, { throwIfNoEntry: false })) return dst;
    if (policy === 'fail') throw new AppError('FILE_EXISTS', { name: basename(dst) });
    if (policy === 'keep-both') {
      for (let i = 1; i < 1000; i++) {
        const c = numbered(dst, i);
        if (!lstatSync(c, { throwIfNoEntry: false })) return c;
      }
      throw new AppError('FILE_EXISTS', { name: basename(dst) });
    }
    this.trashSync(fs, trash, dst, userPath);
    return dst;
  }

  // Inside the transaction: move one item into the trash, cascade its path rows, record the trash row.
  private trashSync(fs: FsSteps, trash: string, abs: string, userPath: string): void {
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st || !(st.isFile() || st.isDirectory())) throw new AppError('NOT_FOUND');
    const id = randomBytes(16).toString('hex');
    fs.rename(abs, join(trash, id));
    const { db, userId, pathTables } = this.index;
    deletePathRefs(db, pathTables, userId, userPath);
    db.prepare('INSERT INTO trash (id, user_id, original_path, type, size, deleted_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, userPath, st.isDirectory() ? 'directory' : 'file', st.isDirectory() ? 0 : st.size, new Date().toISOString());
  }

  private async moveImpl(from: string, to: string, policy: CollisionPolicy): Promise<Entry> {
    const e = await this.endpoints(from, to, policy);
    if (e.nf === e.nt) return this.statImpl(e.nf); // onto itself: nothing to do
    const trash = await this.internalDir('trash');
    const placed = this.atomically((fs) => {
      const target = this.claim(fs, trash, e.dst, e.nt, policy);
      fs.rename(e.src, target);
      const rel = join(dirname(e.nt), basename(target));
      const { db, userId, pathTables } = this.index;
      movePathRefs(db, pathTables, userId, e.nf, rel);
      return rel;
    });
    for (const d of new Set([dirname(e.src), dirname(e.dst), trash])) await syncDir(d);
    return this.statImpl(placed);
  }

  private async copyImpl(from: string, to: string, policy: CollisionPolicy): Promise<Entry> {
    const e = await this.endpoints(from, to, policy);
    const trash = await this.internalDir('trash');
    // Built in the internal area first, so a half-done copy is never visible; the startup sweep clears what a crash leaves.
    const stage = join(await this.internalDir('tmp'), randomBytes(16).toString('hex'));
    try {
      await copyTree(e.src, stage);
      const placed = this.atomically((fs) => {
        const target = this.claim(fs, trash, e.dst, e.nt, policy);
        fs.rename(stage, target);
        return join(dirname(e.nt), basename(target));
      });
      for (const d of new Set([dirname(e.dst), trash])) await syncDir(d);
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
    const items: { p: string; a: string }[] = [];
    for (const p of top) items.push({ p, a: await this.abs(p) });
    const trash = await this.internalDir('trash');
    this.atomically((fs) => { for (const it of items) this.trashSync(fs, trash, it.a, it.p); });
    for (const d of new Set([...items.map((it) => dirname(it.a)), trash])) await syncDir(d);
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
    const tmp = join(dir, `.${randomBytes(8).toString('hex')}.upload`);
    let written = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        if (written > opts.maxBytes) return cb(new AppError('PAYLOAD_TOO_LARGE'));
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
      const rel = normalizeUserPath(p);
      return this.statImpl(join(dirname(rel), basename(finalPath)));
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
