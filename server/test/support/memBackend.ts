import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import type { CollisionPolicy, Entry } from '@files/shared';
import { AppError } from '../../src/errors.ts';
import { withHash, type ByteRange, type StorageBackend, type WriteOptions } from '../../src/storage/backend.ts';

let tick = 0;
/** A modified time that is new on every write, so a file changed later is told apart from the one migrated (#153). */
const nextTime = () => new Date(1_700_000_000_000 + ++tick * 1000).toISOString();

/**
 * An in-memory `StorageBackend` for transfer tests (#152): files and folders in a map, with the faults a transfer has to
 * catch. `lieSize` makes `stat`/`read` claim more bytes than the stream carries; `truncateWrites` and `corruptWrites`
 * make `write` succeed while storing fewer or different bytes; `stall` holds a path's read stream after its first
 * chunk until `release`; `reads` counts reads per path. `digest` is offered only with `withDigest`. With `withMd5`,
 * `read` reports the file's MD5 like Google Drive does (#153); `lieMd5` makes it report the MD5 of other bytes. With
 * `listHash`, `list` and `stat` attach the file's MD5 as the provider's listed hash (#216); `noHash` leaves paths without
 * one. `move` (#215) honours the collision policy; `failMove` makes the move of a path fail with PROVIDER_UNAVAILABLE.
 */
export class MemBackend implements StorageBackend {
  files = new Map<string, Buffer>();
  dirs = new Set<string>(['/']);
  mtimes = new Map<string, string>();
  deleted: string[] = [];
  reads = new Map<string, number>();
  lieSize = new Map<string, number>();
  lieMd5 = new Set<string>();
  truncateWrites = false;
  corruptWrites = false;
  /** `write` stores whatever arrives, whatever size was declared (a provider that does not check). */
  ignoreSize = false;
  private stalls = new Map<string, { release: () => void; promise: Promise<void> }>();
  failMove = new Set<string>();
  noHash = new Set<string>();
  moves: string[] = [];
  private withMd5: boolean;
  private listHash: boolean;
  digest?: (path: string) => Promise<string>;

  constructor(o: { withDigest?: boolean; withMd5?: boolean; listHash?: boolean } = {}) {
    if (o.withDigest) this.digest = async (p) => createHash('sha256').update(this.fileOf(p)).digest('hex');
    this.withMd5 = o.withMd5 ?? false;
    this.listHash = o.listHash ?? false;
  }

  put(path: string, data: string | Buffer): this {
    this.files.set(path, Buffer.from(data));
    this.mtimes.set(path, nextTime());
    for (let d = posix.dirname(path); d !== '/'; d = posix.dirname(d)) this.dirs.add(d);
    return this;
  }
  /** The read of `path` sends its first chunk and then waits until `release(path)`. */
  stall(path: string): void {
    let release!: () => void;
    const promise = new Promise<void>((r) => { release = r; });
    this.stalls.set(path, { release, promise });
  }
  release(path: string): void { this.stalls.get(path)?.release(); this.stalls.delete(path); }

  private fileOf(p: string): Buffer {
    const f = this.files.get(p);
    if (!f) throw new AppError('NOT_FOUND');
    return f;
  }
  private entry(p: string): Entry {
    const name = posix.basename(p) || 'root';
    if (this.dirs.has(p)) return { name, path: p, type: 'directory', size: 0, modified: new Date(0).toISOString() };
    const f = this.fileOf(p);
    const entry: Entry = { name, path: p, type: 'file', size: this.lieSize.get(p) ?? f.length, modified: this.mtimes.get(p)! };
    return this.listHash && !this.noHash.has(p) ? withHash(entry, { algorithm: 'md5', value: createHash('md5').update(f).digest('hex') }) : entry;
  }

  async list(path: string) {
    if (!this.dirs.has(path)) throw new AppError('NOT_FOUND');
    const children = [...this.dirs, ...this.files.keys()].filter((p) => p !== '/' && posix.dirname(p) === path).sort();
    return { entries: children.map((p) => this.entry(p)) };
  }
  async stat(path: string): Promise<Entry> { return this.entry(path); }

  async read(path: string, _range?: ByteRange | ((size: number) => ByteRange | undefined)) {
    if (this.dirs.has(path)) throw new AppError('IS_A_DIRECTORY');
    const data = this.fileOf(path);
    this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
    const stall = this.stalls.get(path);
    const half = Math.max(1, Math.floor(data.length / 2));
    const stream = Readable.from((async function* () {
      yield data.subarray(0, half);
      if (stall) await stall.promise;
      if (data.length > half) yield data.subarray(half);
    })(), { objectMode: false });
    const md5 = createHash('md5').update(data).update(this.lieMd5.has(path) ? 'x' : '').digest('hex');
    return { entry: this.entry(path), stream, etag: `"${data.length}"`,
      ...(this.withMd5 ? { hash: { algorithm: 'md5' as const, value: md5 } } : {}) };
  }

  async write(path: string, body: Readable, opts: WriteOptions): Promise<Entry> {
    if (this.files.has(path) || this.dirs.has(path)) {
      if (opts.onCollision === 'fail') throw new AppError('FILE_EXISTS', { name: posix.basename(path) });
      if (opts.onCollision === 'keep-both') path = path.replace(/(\.[^./]*)?$/, ' (1)$1');
    }
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(c as Buffer);
    let data = Buffer.concat(chunks);
    if (!this.ignoreSize && opts.size !== undefined && data.length !== opts.size) throw new AppError('SIZE_MISMATCH');
    if (this.truncateWrites) data = data.subarray(0, Math.max(0, data.length - 1));
    if (this.corruptWrites && data.length) { data = Buffer.from(data); data[0] = data[0]! ^ 0xff; }
    this.put(path, data);
    return this.entry(path);
  }
  async mkdir(path: string): Promise<Entry> {
    if (this.files.has(path) || this.dirs.has(path)) throw new AppError('FILE_EXISTS', { name: posix.basename(path) });
    this.dirs.add(path);
    return this.entry(path);
  }
  async move(from: string, to: string, onCollision: CollisionPolicy): Promise<Entry> {
    this.moves.push(from);
    if (this.failMove.has(from)) throw new AppError('PROVIDER_UNAVAILABLE');
    if (!this.files.has(from)) throw new AppError(this.dirs.has(from) ? 'NOT_SUPPORTED' : 'NOT_FOUND');
    if (this.files.has(to) || this.dirs.has(to)) {
      if (onCollision === 'fail') throw new AppError('FILE_EXISTS', { name: posix.basename(to) });
      if (onCollision === 'keep-both') to = to.replace(/(\.[^./]*)?$/, ' (1)$1');
      else await this.delete([to]);
    }
    this.files.set(to, this.files.get(from)!); this.mtimes.set(to, this.mtimes.get(from)!);
    this.files.delete(from); this.mtimes.delete(from);
    return this.entry(to);
  }
  async copy(_from: string, _to: string, _c: CollisionPolicy): Promise<Entry> { throw new Error('not used'); }
  async delete(paths: readonly string[]): Promise<void> {
    for (const p of paths) {
      if (!this.files.has(p) && !this.dirs.has(p)) throw new AppError('NOT_FOUND');
    }
    for (const p of paths) {
      this.deleted.push(p);
      for (const f of [...this.files.keys()]) if (f === p || f.startsWith(p + '/')) this.files.delete(f);
      for (const d of [...this.dirs]) if (d === p || d.startsWith(p + '/')) this.dirs.delete(d);
    }
  }
}
