import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import sharp, { type Sharp } from 'sharp';
import type { ThumbSize } from '@files/shared';
import { AppError } from '../errors.ts';
import type { Db } from '../db.ts';
import type { DiskReserve } from './diskReserve.ts';

/** Generators running at once, across all members: thumbnails must not starve requests on small hardware. */
export const THUMB_CONCURRENCY = 2;
/** What a new thumbnail needs left above the disk reserve (#320); the largest WebP is far smaller. */
const THUMB_ROOM = 1024 ** 2;

const IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
// The ffmpeg demuxer is fixed by the type, so the file's content can never select a playlist or concat demuxer that
// would open other files (HLS, concat, image2 patterns); together with `-protocol_whitelist file` nothing else is read.
const VIDEO_DEMUXER: Record<string, string> = { 'video/mp4': 'mov', 'video/quicktime': 'mov', 'video/webm': 'matroska', 'video/ogg': 'ogg' };
type Kind = 'image' | 'video' | 'pdf';

/** Which generator a type has; undefined for types without a thumbnail (SVG and HEIC included, see DECISIONS). */
export function thumbnailKind(mime: string): Kind | undefined {
  if (IMAGES.has(mime)) return 'image';
  if (Object.hasOwn(VIDEO_DEMUXER, mime)) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  return undefined;
}

/** A file the cache may thumbnail: `abs` comes from `resolveInRoot`, `etag` identifies the version on disk. */
export type ThumbSource = { userId: string; path: string; abs: string; etag: string; mime: string };

// The input could not be turned into a thumbnail (corrupt, unsupported inside, too slow): THUMBNAIL_FAILED.
class GeneratorFailed extends Error {}

// A file reaches a tool only as the normalised absolute path resolveInRoot produced. It starts with `/`, so no tool can
// read it as an option; the callers still put it after `--` or behind `file:` where the tool has such a form.
function fileArg(abs: string): string {
  if (!isAbsolute(abs) || normalize(abs) !== abs) throw new Error('a thumbnail source must be a normalised absolute path');
  return abs;
}

// Spawns a tool without a shell, with its arguments as an array. It is killed with SIGKILL once `timeoutMs` has passed.
// `done` rejects with GeneratorFailed on a non-zero exit or the timeout, and with the spawn error itself (a missing
// tool is a broken installation, not a bad file).
function runTool(cmd: string, args: string[], timeoutMs: number): { child: ChildProcess; stdout: Readable; done: Promise<void> } {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (d: string) => { if (stderr.length < 2000) stderr += d; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new GeneratorFailed(`${cmd} exceeded ${timeoutMs} ms and was killed`));
      else if (code !== 0) reject(new GeneratorFailed(`${cmd} exited with ${code ?? signal}: ${stderr.trim()}`));
      else resolve();
    });
  });
  return { child, stdout: child.stdout!, done };
}

const resize = (s: Sharp, size: ThumbSize) =>
  s.rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 });

// Renders one thumbnail into `out`. Images are decoded by libvips in-process (shrink-on-load, never a process); a video
// frame and a PDF page come from ffmpeg and pdftoppm as a small PNG on stdout, which sharp turns into the WebP.
async function render(kind: Kind, src: ThumbSource, size: ThumbSize, timeoutMs: number, out: string): Promise<void> {
  if (kind === 'image') {
    await resize(sharp(fileArg(src.abs)), size).timeout({ seconds: Math.max(1, Math.ceil(timeoutMs / 1000)) }).toFile(out)
      .catch((e: unknown) => { throw new GeneratorFailed('image could not be decoded', { cause: e }); });
    return;
  }
  const args = kind === 'video'
    ? ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-f', VIDEO_DEMUXER[src.mime]!,
      '-i', `file:${fileArg(src.abs)}`, '-an', '-sn', '-dn',
      // `thumbnail` picks the most typical of the first frames, so a fade-in does not give a black tile.
      '-vf', `thumbnail=24,scale=${size}:${size}:force_original_aspect_ratio=decrease`,
      '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']
    : ['-f', '1', '-l', '1', '-scale-to', String(size), '-png', '-singlefile', '--', fileArg(src.abs)];
  const tool = runTool(kind === 'video' ? 'ffmpeg' : 'pdftoppm', args, timeoutMs);
  const encoder = resize(sharp(), size);
  const encoded = encoder.toFile(out);
  tool.stdout.pipe(encoder);
  // If the encoder gives up first, the tool must not block on a full pipe until its timeout.
  const [ran, enc] = await Promise.allSettled([tool.done, encoded.catch((e: unknown) => { tool.child.kill('SIGKILL'); throw e; })]);
  if (ran.status === 'rejected') throw ran.reason;
  if (enc.status === 'rejected') throw new GeneratorFailed(`${kind} output could not be encoded`, { cause: enc.reason });
}

// At most `max` callers run at once; the others wait in order.
class Gate {
  private running = 0;
  private waiting: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running < this.max) this.running++;
    else await new Promise<void>((r) => this.waiting.push(r)); // the slot is handed over, `running` stays
    try { return await fn(); } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.running--;
    }
  }
}

const isErr = (e: unknown, code: string) => (e as NodeJS.ErrnoException).code === code;
const FILE = /^([0-9a-f]{32})\.webp$/;
// The item itself or anything beneath it (as in pathRefs.ts).
const UNDER = `(path = @p OR substr(path, 1, length(@p) + 1) = @p || '/')`;

/**
 * Local thumbnails (#144): generated lazily, kept as WebP files under `thumbsDir` (paths.ts) with one `thumbnails` row
 * each, and evicted least recently used first once the files exceed `capBytes`. A row whose ETag no longer matches the
 * file is regenerated, so a change made outside the app is never served stale.
 */
export class ThumbnailCache {
  private gate = new Gate(THUMB_CONCURRENCY);
  private inflight = new Map<string, Promise<string>>();
  private clock: number;

  constructor(private opts: { db: Db; dir: string; capBytes: number; timeoutMs: number; disk: DiskReserve }) {
    this.clock = (opts.db.prepare('SELECT COALESCE(MAX(used_at), 0) FROM thumbnails').pluck().get() as number);
  }

  // Strictly increasing, so two uses in the same millisecond still have an order.
  private tick(): number { this.clock = Math.max(Date.now(), this.clock + 1); return this.clock; }
  private file(id: string): string { return join(this.opts.dir, `${id}.webp`); }

  /** The thumbnail as a stream, from the cache or freshly generated; null if the type has none. */
  async get(src: ThumbSource, size: ThumbSize): Promise<Readable | null> {
    const kind = thumbnailKind(src.mime);
    if (!kind) return null;
    const row = this.opts.db.prepare('SELECT id, etag FROM thumbnails WHERE user_id = ? AND path = ? AND size = ?')
      .get(src.userId, src.path, size) as { id: string; etag: string } | undefined;
    if (row?.etag === src.etag) {
      const hit = await this.openThumb(row.id);
      if (hit) return hit;
    }
    // One generator per file version and size, however many requests ask for it at once.
    const key = JSON.stringify([src.userId, src.path, size, src.etag]);
    let pending = this.inflight.get(key);
    if (!pending) {
      // Below the disk reserve (#320) no new thumbnail is made: the file shows its icon, the request never fails for it.
      if (await this.opts.disk.left() < THUMB_ROOM) return null;
      pending = this.gate.run(() => this.generate(kind, src, size)).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const id = await pending;
    const fresh = await this.openThumb(id);
    if (!fresh) throw new Error(`thumbnail ${id} was evicted before it could be served; the cache cap is too small`);
    return fresh;
  }

  // Opens a cached file and marks it used; a row whose file is gone is dropped.
  private async openThumb(id: string): Promise<Readable | null> {
    const fh = await open(this.file(id), constants.O_RDONLY | constants.O_NOFOLLOW).catch((e: unknown) => {
      if (isErr(e, 'ENOENT')) return null; // handled: the row is dropped below and the thumbnail generated again
      throw e;
    });
    if (!fh) { this.opts.db.prepare('DELETE FROM thumbnails WHERE id = ?').run(id); return null; }
    this.opts.db.prepare('UPDATE thumbnails SET used_at = ? WHERE id = ?').run(this.tick(), id);
    return fh.createReadStream({ autoClose: true });
  }

  private async generate(kind: Kind, src: ThumbSource, size: ThumbSize): Promise<string> {
    await mkdir(this.opts.dir, { recursive: true });
    const id = randomBytes(16).toString('hex');
    const tmp = join(this.opts.dir, `${id}.tmp`);
    try {
      await render(kind, src, size, this.opts.timeoutMs, tmp);
      await rename(tmp, this.file(id));
    } catch (e) {
      await rm(tmp, { force: true });
      if (e instanceof GeneratorFailed) throw new AppError('THUMBNAIL_FAILED', undefined, { cause: e });
      throw e;
    }
    const bytes = (await stat(this.file(id))).size;
    const { db } = this.opts;
    const old = db.transaction(() => {
      const stale = db.prepare('SELECT id FROM thumbnails WHERE user_id = ? AND path = ? AND size = ?').pluck()
        .all(src.userId, src.path, size) as string[];
      db.prepare('DELETE FROM thumbnails WHERE user_id = ? AND path = ? AND size = ?').run(src.userId, src.path, size);
      db.prepare('INSERT INTO thumbnails (id, user_id, path, size, etag, bytes, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, src.userId, src.path, size, src.etag, bytes, this.tick());
      return stale;
    }).immediate();
    await this.removeFiles(old);
    await this.evict(id);
    return id;
  }

  // Least recently used first, until the files fit under the cap again. `keep` (the one just made) is never chosen.
  private async evict(keep: string): Promise<void> {
    const { db, capBytes } = this.opts;
    let over = (db.prepare('SELECT COALESCE(SUM(bytes), 0) FROM thumbnails').pluck().get() as number) - capBytes;
    if (over <= 0) return;
    const victims: string[] = [];
    for (const r of db.prepare('SELECT id, bytes FROM thumbnails WHERE id != ? ORDER BY used_at').iterate(keep) as Iterable<{ id: string; bytes: number }>) {
      if (over <= 0) break;
      victims.push(r.id); over -= r.bytes;
    }
    db.transaction(() => { for (const v of victims) db.prepare('DELETE FROM thumbnails WHERE id = ?').run(v); }).immediate();
    await this.removeFiles(victims);
  }

  private async removeFiles(ids: readonly string[]): Promise<void> {
    for (const id of ids) await rm(this.file(id), { force: true });
  }

  /** Drops the thumbnails of `path` and of everything beneath it: called after a write, move or delete in the app. */
  async forget(userId: string, path: string): Promise<void> {
    const { db } = this.opts;
    const ids = db.transaction(() => {
      const found = db.prepare(`SELECT id FROM thumbnails WHERE user_id = @u AND ${UNDER}`).pluck().all({ u: userId, p: path }) as string[];
      db.prepare(`DELETE FROM thumbnails WHERE user_id = @u AND ${UNDER}`).run({ u: userId, p: path });
      return found;
    }).immediate();
    await this.removeFiles(ids);
  }

  /**
   * Startup: removes files without a row (a crash between writing and recording, or temp files) and rows without a
   * file, then evicts down to the cap, which may have been lowered.
   */
  async sweep(log: FastifyBaseLogger): Promise<void> {
    const { db, dir } = this.opts;
    await mkdir(dir, { recursive: true });
    const rows = new Set(db.prepare('SELECT id FROM thumbnails').pluck().all() as string[]);
    const onDisk = new Set<string>();
    let removed = 0;
    for (const name of await readdir(dir)) {
      const m = FILE.exec(name);
      if (m && rows.has(m[1]!)) { onDisk.add(m[1]!); continue; }
      await rm(join(dir, name), { force: true, recursive: true }); removed++;
    }
    const missing = [...rows].filter((id) => !onDisk.has(id));
    db.transaction(() => { for (const id of missing) db.prepare('DELETE FROM thumbnails WHERE id = ?').run(id); }).immediate();
    await this.evict('');
    log.info({ removed, missingRows: missing.length }, 'thumbnail cache swept');
  }
}
