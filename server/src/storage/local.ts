import { createReadStream, createWriteStream } from 'node:fs';
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
const isErr = (e: unknown, code: string) => (e as NodeJS.ErrnoException).code === code;

export function homeRoot(dataDir: string, userId: string): string {
  return join(dataDir, 'homes', userId);
}

export class LocalBackend implements StorageBackend {
  constructor(private root: string) {}

  // Every user path goes through here: normalise, refuse the internal area, resolve inside the root.
  private async abs(p: string) {
    const n = normalizeUserPath(p);
    if (n === `/${INTERNAL}` || n.startsWith(`/${INTERNAL}/`)) throw new AppError('PATH_INVALID');
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

  async stat(p: string): Promise<Entry> {
    const a = await this.abs(p);
    try { return this.entry(p, await lstat(a)); }
    catch (e) { if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND'); throw e; }
  }

  async list(p: string, cursor?: string, limit = 500) {
    const a = await this.abs(p);
    let dirents;
    try { dirents = await readdir(a, { withFileTypes: true }); }
    catch (e) {
      if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND');
      if (isErr(e, 'ENOTDIR')) throw new AppError('NOT_A_DIRECTORY');
      throw e;
    }
    const base = normalizeUserPath(p);
    const visible = dirents
      .filter((d) => !(base === '/' && d.name === INTERNAL) && (d.isFile() || d.isDirectory()))
      .sort((x, y) => (x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name, 'en') : x.isDirectory() ? -1 : 1));
    const start = cursor ? Number(Buffer.from(cursor, 'base64url').toString()) : 0;
    if (!Number.isInteger(start) || start < 0) throw new AppError('VALIDATION');
    const slice = visible.slice(start, start + limit);
    const entries = await Promise.all(slice.map(async (d) => {
      const child = (base === '/' ? '' : base) + '/' + d.name;
      return this.entry(child, await lstat(join(a, d.name)));
    }));
    const nextIdx = start + slice.length;
    return nextIdx < visible.length ? { entries, next: Buffer.from(String(nextIdx)).toString('base64url') } : { entries };
  }

  async read(p: string, range?: { start: number; end: number }) {
    const a = await this.abs(p);
    let st;
    try { st = await lstat(a); }
    catch (e) { if (isErr(e, 'ENOENT')) throw new AppError('NOT_FOUND'); throw e; }
    if (st.isDirectory()) throw new AppError('IS_A_DIRECTORY');
    if (range && (range.start > range.end || range.end >= st.size)) throw new AppError('RANGE_NOT_SATISFIABLE');
    const stream = createReadStream(a, range ? { start: range.start, end: range.end } : {});
    return { stream, size: st.size, etag: `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`, mime: lookupMime(basename(a)) };
  }

  async mkdir(p: string): Promise<Entry> {
    const a = await this.abs(p);
    const exists = await lstat(a).then(() => true, (e) => { if (isErr(e, 'ENOENT')) return false; throw e; });
    if (exists) throw new AppError('FILE_EXISTS');
    await mkdir(a, { recursive: true });
    return this.stat(p);
  }

  async write(p: string, body: Readable, opts: { onCollision: CollisionPolicy; maxBytes: number }): Promise<Entry> {
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
      return this.stat(join(dirname(rel), basename(finalPath)));
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
  return join(dirname(target), `${basename(target, ext)} (${n})${ext}`);
}
