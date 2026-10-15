import { constants, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CollisionPolicy, Entry } from '@files/shared';
import { AppError } from '../errors.ts';
import { normalizeUserPath, resolveInRoot } from './resolveInRoot.ts';
import type { StorageBackend } from './backend.ts';
import { lookupMime } from './mime.ts';

const INTERNAL = '.files';
const TEMP_NAME = /^\.[0-9a-f]{16}\.upload$/;
const MAX_NAME_BYTES = 255;
const MAX_LIMIT = 1000;
const isErr = (e: unknown, code: string) => (e as NodeJS.ErrnoException).code === code;

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

export class LocalBackend implements StorageBackend {
  constructor(private root: string) {}

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
  read(p: string, range?: { start: number; end: number }) { return this.readImpl(p, range).catch(rethrowMapped); }
  mkdir(p: string): Promise<Entry> { return this.mkdirImpl(p).catch(rethrowMapped); }
  write(p: string, body: Readable, opts: { onCollision: CollisionPolicy; maxBytes: number }): Promise<Entry> {
    return this.writeImpl(p, body, opts).catch(rethrowMapped);
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

  private async readImpl(p: string, range?: { start: number; end: number }) {
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
      if (range && (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.start > range.end || range.end >= st.size)) {
        throw new AppError('RANGE_NOT_SATISFIABLE');
      }
      const stream = fh.createReadStream({ autoClose: true, ...(range ? { start: range.start, end: range.end } : {}) });
      const etag = `"${st.ino.toString(16)}-${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      return { stream, size: st.size, etag, mime: lookupMime(basename(a)) };
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

  private async writeImpl(p: string, body: Readable, opts: { onCollision: CollisionPolicy; maxBytes: number }): Promise<Entry> {
    const target = await this.abs(p);
    const dir = dirname(target);
    await mkdir(dir, { recursive: true });
    const st = await lstat(target).then((s) => s, (e) => { if (isErr(e, 'ENOENT')) return undefined; throw e; });
    if (st?.isDirectory()) throw new AppError('IS_A_DIRECTORY');
    const tmp = join(dir, `.${randomBytes(8).toString('hex')}.upload`);
    let written = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        cb(written > opts.maxBytes ? new AppError('PAYLOAD_TOO_LARGE') : null, chunk);
      },
    });
    try {
      await pipeline(body, limiter, createWriteStream(tmp, { flags: 'wx' }));
      const fh = await open(tmp, 'r+'); await fh.sync(); await fh.close();
      const finalPath = await this.place(tmp, target, opts.onCollision);
      const rel = normalizeUserPath(p);
      return this.statImpl(join(dirname(rel), basename(finalPath)));
    } catch (e) {
      await unlink(tmp).catch((u) => { if (!isErr(u, 'ENOENT')) throw u; }); // handled: tmp may not exist yet
      throw e;
    }
  }

  private async place(tmp: string, target: string, policy: CollisionPolicy): Promise<string> {
    if (policy === 'replace') { await rename(tmp, target); return target; }
    const candidates = policy === 'fail' ? [target] : Array.from({ length: 1000 }, (_, i) => i === 0 ? target : numbered(target, i + 1));
    for (const c of candidates) {
      try { await link(tmp, c); await unlink(tmp); return c; }
      catch (e) { if (!isErr(e, 'EEXIST')) throw e; }
    }
    throw new AppError('FILE_EXISTS', { name: basename(target) });
  }
}

function numbered(target: string, n: number): string {
  const ext = extname(target);
  const suffix = ` (${n})${ext}`;
  const stem = truncateBytes(basename(target, ext), Math.max(0, MAX_NAME_BYTES - Buffer.byteLength(suffix)));
  return join(dirname(target), `${stem}${suffix}`);
}
