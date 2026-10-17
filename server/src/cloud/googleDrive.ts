import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import sharp from 'sharp';
import { z } from 'zod';
import type { CollisionPolicy, Entry, ThumbSize } from '@files/shared';
import { AppError } from '../errors.ts';
import { RangeNotSatisfiable, withHash, type ByteRange, type Revision, type StorageBackend, type WriteOptions } from '../storage/backend.ts';
import { lookupMime } from '../storage/mime.ts';
import { normalizeUserPath } from '../storage/resolveInRoot.ts';
import type { OAuthClient, Provider } from './oauth.ts';

// Google Drive (#149): a `StorageBackend` over the Drive v3 API, live, through the connection's OAuthClient (refresh,
// rotation, backoff). Drive addresses items by id and allows one folder to hold several items of the same name, so
// paths are resolved segment by segment to ids (cached briefly per connection), and items whose name is taken twice,
// or cannot be a path segment, are listed with their id in the name instead of being merged or hidden.

/** Where the server talks to Google. Fixed here, never taken from a request or from config (spec §3.7). */
export type DriveEndpoints = {
  authorization: string; token: string;
  /** Drive v3 (`…/drive/v3`) and its upload host (`…/upload/drive/v3`). */
  api: string; upload: string;
  /** Hosts a content or thumbnail download may be redirected to (pre-signed URLs). Nothing else is followed. */
  contentHost(u: URL): boolean;
  /**
   * Hosts a file's `thumbnailLink` may point at. Drive requires the link of a file not shared publicly to be fetched
   * with credentials, so this first request carries the bearer token; a redirect from it is followed only to a
   * content host and without the token (DECISIONS, #203).
   */
  thumbnailHost(u: URL): boolean;
};
export const GOOGLE_DRIVE_ENDPOINTS: DriveEndpoints = {
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  api: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
  contentHost: (u) => u.protocol === 'https:' && (u.hostname === 'www.googleapis.com' || u.hostname.endsWith('.googleusercontent.com')),
  // Stored files: `lh3.googleusercontent.com/…=s220`; Google Docs, Sheets and Slides: `docs.google.com/feeds/vt?…&sz=s220`.
  thumbnailHost: (u) => u.protocol === 'https:' && (u.hostname === 'docs.google.com' || u.hostname.endsWith('.googleusercontent.com')),
};
/** The whole Drive (DECISIONS #149): browsing needs it; `drive.file` would only show files the app created. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
/** Bytes per upload-session request: Drive wants a multiple of 256 KiB. One chunk is all an upload holds in memory. */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const CHUNK_UNIT = 256 * 1024;
/** How long a resolved path → id is trusted. Changes through this app drop it at once; changes elsewhere show after this. */
export const PATH_CACHE_MS = 30_000;
const MAX_REDIRECTS = 3;

const FOLDER = 'application/vnd.google-apps.folder';
const NATIVE = 'application/vnd.google-apps.';
/** Google-native documents and the office format they are listed as and exported to. Other native types (forms, sites, maps, shortcuts) are listed but not downloadable. */
const EXPORTS: Record<string, { ext: string; mime: string }> = {
  [`${NATIVE}document`]: { ext: 'docx', mime: lookupMime('x.docx') },
  [`${NATIVE}spreadsheet`]: { ext: 'xlsx', mime: lookupMime('x.xlsx') },
  [`${NATIVE}presentation`]: { ext: 'pptx', mime: lookupMime('x.pptx') },
  [`${NATIVE}drawing`]: { ext: 'pdf', mime: 'application/pdf' },
};
const FIELDS = 'id,name,mimeType,size,modifiedTime,md5Checksum,parents,trashed,thumbnailLink';

const DriveFile = z.object({
  id: z.string().min(1), name: z.string(), mimeType: z.string(), size: z.string().optional(), modifiedTime: z.string(),
  md5Checksum: z.string().optional(), parents: z.array(z.string()).optional(), trashed: z.boolean().optional(),
  thumbnailLink: z.string().optional(),
});
type DriveFile = z.infer<typeof DriveFile>;
const FileList = z.object({ files: z.array(DriveFile), nextPageToken: z.string().optional() });
const DriveError = z.object({ error: z.object({ errors: z.array(z.object({ reason: z.string().optional() })).optional() }) });

const isFolder = (f: DriveFile) => f.mimeType === FOLDER;
const isNative = (f: DriveFile) => !isFolder(f) && f.mimeType.startsWith(NATIVE);
const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const etagOf = (f: DriveFile) => `"${f.md5Checksum ?? f.modifiedTime}"`;
const fromWeb = (body: ReadableStream<Uint8Array>) => Readable.fromWeb(body as WebReadableStream<Uint8Array>);
const discard = async (res: Response) => { await res.body?.cancel(); };

/**
 * The name an item is listed under, before duplicates are told apart: Drive's name in NFC with characters a path
 * segment cannot hold replaced, plus the export extension for a Google-native document. `exact` is false when Drive's
 * name had to be changed, so it could not be found by name.
 */
function plainName(f: DriveFile): { name: string; exact: boolean } {
  let name = f.name.normalize('NFC').replace(/[/\\\p{Cc}\p{Bidi_Control}]/gu, '_');
  if (name === '' || name === '.' || name === '..') name = '_';
  const exact = name === f.name;
  const exp = EXPORTS[f.mimeType];
  if (exp && !name.toLowerCase().endsWith(`.${exp.ext}`)) name += `.${exp.ext}`;
  return { name, exact };
}
/** `report (~<id>).pdf`: the listed name of an item whose plain name is taken twice in its folder, or is not exact. */
function marked(name: string, id: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (~${id})${name.slice(dot)}` : `${name} (~${id})`;
}
const MARK = /^.* \(~([A-Za-z0-9_-]+)\)(?:\.[^.]*)?$/;

/** Listed names of one folder's items: exact names taken once stay plain, every other one carries the item's id. */
function listedNames(items: DriveFile[]): Map<string, string> {
  const plain = items.map((f) => ({ f, ...plainName(f) }));
  const count = new Map<string, number>();
  for (const p of plain) if (p.exact) count.set(p.name, (count.get(p.name) ?? 0) + 1);
  return new Map(plain.map((p) => [p.f.id, p.exact && count.get(p.name) === 1 ? p.name : marked(p.name, p.f.id)]));
}

/** Maps a Drive error answer to an error code; anything unexpected is a plain Error (500, logged) with the status only. */
async function failure(res: Response, what: string): Promise<never> {
  const text = await res.text();
  let reason: string | undefined;
  try { reason = DriveError.parse(JSON.parse(text)).error.errors?.[0]?.reason; }
  catch { reason = undefined; } // handled: a body that is not Drive's JSON error leaves the status to decide
  if (res.status === 404) throw new AppError('NOT_FOUND');
  if (res.status === 403 && (reason === 'storageQuotaExceeded' || reason === 'quotaExceeded')) throw new AppError('STORAGE_FULL');
  if (res.status === 403 && /rateLimitExceeded/i.test(reason ?? '')) throw new AppError('PROVIDER_UNAVAILABLE');
  if (res.status === 403) throw new AppError('FORBIDDEN');
  throw new Error(`Google Drive ${what} answered ${res.status}${reason ? ` (${reason})` : ''}`);
}

type Cached = { id: string; folder: boolean; at: number };
// One path cache per connection: OAuthClients live once per connection and process, backends are built per request.
const caches = new WeakMap<OAuthClient, Map<string, Cached>>();

export class GoogleDriveBackend implements StorageBackend {
  private cache: Map<string, Cached>;

  constructor(private client: OAuthClient, private ep: DriveEndpoints, private chunkBytes: number) {
    let c = caches.get(client);
    if (!c) { c = new Map(); caches.set(client, c); }
    this.cache = c;
  }

  // --- requests ---------------------------------------------------------------------------------------------------

  private url(base: string, path: string, query: Record<string, string> = {}): URL {
    const u = new URL(base + path);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  /** A Drive API request; any answer but 2xx becomes an error. Redirects are never followed here. */
  private async api(method: string, path: string, o: { query?: Record<string, string>; json?: unknown } = {}): Promise<Response> {
    const res = await this.client.fetch(this.url(this.ep.api, path, o.query), { method, redirect: 'manual',
      ...(o.json !== undefined ? { body: JSON.stringify(o.json), headers: { 'content-type': 'application/json; charset=UTF-8' } } : {}) });
    if (!res.ok) await failure(res, `${method} ${path.replace(/\/files\/[^/]+/, '/files/<id>')}`);
    return res;
  }
  private async file(id: string): Promise<DriveFile> {
    return DriveFile.parse(await (await this.api('GET', `/files/${encodeURIComponent(id)}`, { query: { fields: FIELDS } })).json());
  }

  private async *pages(q: string, pageSize = 1000): AsyncGenerator<DriveFile[]> {
    let pageToken: string | undefined;
    do {
      const res = await this.api('GET', '/files', { query: { q, fields: `nextPageToken,files(${FIELDS})`, pageSize: String(pageSize),
        spaces: 'drive', orderBy: 'folder,name', ...(pageToken !== undefined ? { pageToken } : {}) } });
      const page = FileList.parse(await res.json());
      yield page.files;
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
  }
  private async query(q: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    for await (const page of this.pages(q)) out.push(...page);
    return out;
  }
  private children(parentId: string) { return this.query(`${quote(parentId)} in parents and trashed = false`); }

  /**
   * Content bytes or a thumbnail: Drive may answer with a redirect to a pre-signed URL. It is followed only to the provider's content
   * hosts and without the bearer token, so neither a foreign host nor the token ever gets a request.
   */
  private async content(url: URL, range?: ByteRange): Promise<Response> {
    const headers: Record<string, string> = range ? { range: `bytes=${range.start}-${range.end}` } : {};
    let res = await this.client.fetch(url, { headers, redirect: 'manual' });
    for (let hops = 0; res.status >= 300 && res.status < 400; hops++) {
      const location = res.headers.get('location');
      await discard(res);
      const next = location === null ? undefined : new URL(location, url);
      if (!next || hops >= MAX_REDIRECTS || !this.ep.contentHost(next)) {
        throw new Error(`Google Drive redirected a download to ${next?.host ?? 'nowhere'}, which is not one of its content hosts`);
      }
      res = await fetch(next, { headers, redirect: 'manual' });
    }
    return res;
  }

  // --- paths ------------------------------------------------------------------------------------------------------

  private remember(path: string, f: DriveFile) { this.cache.set(path, { id: f.id, folder: isFolder(f), at: Date.now() }); }
  private cached(path: string): Cached | undefined {
    const c = this.cache.get(path);
    if (c && Date.now() - c.at < PATH_CACHE_MS) return c;
    this.cache.delete(path);
    return undefined;
  }
  /** Drops a changed path and everything beneath it. */
  private forget(path: string) {
    for (const k of this.cache.keys()) if (k === path || k.startsWith(path === '/' ? '/' : `${path}/`)) this.cache.delete(k);
  }

  private async rootId(): Promise<string> {
    const c = this.cached('/');
    if (c) return c.id;
    const root = await this.file('root');
    this.remember('/', root);
    return root.id;
  }

  /** Items of `parentId` that Drive would list under `seg` by name (an export extension may be part of `seg`). */
  private async named(parentId: string, seg: string): Promise<DriveFile[]> {
    const raws = new Set([seg]);
    for (const e of Object.values(EXPORTS)) if (seg.toLowerCase().endsWith(`.${e.ext}`)) raws.add(seg.slice(0, -(e.ext.length + 1)));
    const found = await this.query(`${quote(parentId)} in parents and trashed = false and (${[...raws].map((n) => `name = ${quote(n)}`).join(' or ')})`);
    return found.filter((f) => { const p = plainName(f); return p.exact && p.name === seg; });
  }

  /**
   * The item listed as `seg` in the folder: by its plain name when exactly one item has it (more than one is
   * AMBIGUOUS_NAME, never the first of them), else by the id in a marked name. Undefined when there is none.
   */
  private async child(parentId: string, seg: string): Promise<DriveFile | undefined> {
    const hits = await this.named(parentId, seg);
    if (hits.length > 1) throw new AppError('AMBIGUOUS_NAME', { name: seg });
    if (hits.length === 1) return hits[0];
    const m = MARK.exec(seg);
    if (!m) return undefined;
    const f = await this.file(m[1]!).catch((e: unknown) => {
      if (e instanceof AppError && e.code === 'NOT_FOUND') return undefined; // handled: an unknown id is simply not there
      throw e;
    });
    return f && !f.trashed && f.parents?.includes(parentId) && marked(plainName(f).name, f.id) === seg ? f : undefined;
  }

  /** The name `f` is listed under in `parentId`: plain, or marked when it is taken twice or not exact. */
  private async listedName(parentId: string, f: DriveFile): Promise<string> {
    const p = plainName(f);
    if (!p.exact) return marked(p.name, f.id);
    return (await this.named(parentId, p.name)).length > 1 ? marked(p.name, f.id) : p.name;
  }

  /** The id at `path`, segment by segment through the cache; with `create`, missing folders are made on the way. */
  private async lookup(path: string, create = false): Promise<Cached> {
    if (path === '/') return { id: await this.rootId(), folder: true, at: 0 };
    const hit = this.cached(path);
    if (hit) return hit;
    const parent = await this.lookup(posix.dirname(path), create);
    if (!parent.folder) throw new AppError('NOT_A_DIRECTORY');
    let f = await this.child(parent.id, posix.basename(path));
    if (!f && create) f = await this.createFolder(parent.id, posix.basename(path));
    if (!f) throw new AppError('NOT_FOUND');
    this.remember(path, f);
    return this.cached(path)!;
  }
  private async folderId(path: string, create = false): Promise<string> {
    const c = await this.lookup(path, create);
    if (!c.folder) throw new AppError('NOT_A_DIRECTORY');
    return c.id;
  }

  /** The item at `path`, with fresh metadata. A cached id whose item is gone meanwhile is resolved once more. */
  private async resolve(path: string): Promise<DriveFile> {
    const fromCache = path !== '/' && this.cached(path) !== undefined;
    const f = await this.file((await this.lookup(path)).id);
    if (!f.trashed) return f;
    if (fromCache) { this.forget(path); return this.resolve(path); }
    throw new AppError('NOT_FOUND');
  }

  private entry(f: DriveFile, path: string, name: string): Entry {
    const dir = isFolder(f);
    // Drive's MD5 of a stored file (none for a folder or a Google-native document), for the duplicate finder (#216).
    return withHash({ name, path, type: dir ? 'directory' : 'file', size: dir || isNative(f) ? 0 : Number(f.size ?? 0),
      modified: new Date(f.modifiedTime).toISOString(), ...(dir ? {} : { mime: lookupMime(name) }) },
      !dir && f.md5Checksum ? { algorithm: 'md5', value: f.md5Checksum.toLowerCase() } : undefined);
  }

  /** Drive's own name for `f` when it is to be called `name` (the id marker and an added export extension removed). */
  private rawName(f: DriveFile, name: string): string {
    let raw = name.replace(` (~${f.id})`, '');
    const exp = EXPORTS[f.mimeType];
    if (exp && raw.toLowerCase().endsWith(`.${exp.ext}`) && !f.name.toLowerCase().endsWith(`.${exp.ext}`)) raw = raw.slice(0, -(exp.ext.length + 1));
    return raw;
  }

  /** `name (n).ext` with the lowest n that no item of the folder is listed under. */
  private async freeName(parentId: string, name: string): Promise<string> {
    const taken = new Set((await this.children(parentId)).map((f) => plainName(f).name));
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 1; ; n++) if (!taken.has(`${stem} (${n})${ext}`)) return `${stem} (${n})${ext}`;
  }

  private async createFolder(parentId: string, name: string): Promise<DriveFile> {
    const res = await this.api('POST', '/files', { query: { fields: FIELDS }, json: { name, mimeType: FOLDER, parents: [parentId] } });
    return DriveFile.parse(await res.json());
  }
  /** Drive's trash: the item stays restorable at Google. A permanent delete is never sent. */
  private async setTrashed(id: string, trashed: boolean): Promise<void> {
    await discard(await this.api('PATCH', `/files/${encodeURIComponent(id)}`, { query: { fields: 'id' }, json: { trashed } }));
  }

  // --- StorageBackend ---------------------------------------------------------------------------------------------

  /** Follows the pagination to the end, so duplicates are found across pages. */
  async list(path: string): Promise<{ entries: Entry[] }> {
    const dirPath = normalizeUserPath(path);
    const dir = await this.resolve(dirPath);
    if (!isFolder(dir)) throw new AppError('NOT_A_DIRECTORY');
    const items = await this.children(dir.id);
    const names = listedNames(items);
    return { entries: items.map((f) => {
      const name = names.get(f.id)!;
      const p = posix.join(dirPath, name);
      this.remember(p, f);
      return this.entry(f, p, name);
    }) };
  }

  async stat(path: string): Promise<Entry> {
    const p = normalizeUserPath(path);
    const f = await this.resolve(p);
    return this.entry(f, p, p === '/' ? f.name : posix.basename(p));
  }

  async read(path: string, range?: ByteRange | ((size: number) => ByteRange | undefined)) {
    const p = normalizeUserPath(path);
    const f = await this.resolve(p);
    if (isFolder(f)) throw new AppError('IS_A_DIRECTORY');
    const entry = this.entry(f, p, posix.basename(p));
    const etag = etagOf(f);
    if (isNative(f)) {
      const exp = EXPORTS[f.mimeType];
      if (!exp) throw new AppError('NOT_EXPORTABLE');
      // An export has no ranges and no length up front: the whole document, sent as it comes.
      const res = await this.content(this.url(this.ep.api, `/files/${encodeURIComponent(f.id)}/export`, { mimeType: exp.mime }));
      if (!res.ok || !res.body) await failure(res, 'export');
      return { entry, stream: fromWeb(res.body!), etag, unsized: true };
    }
    const r = typeof range === 'function' ? range(entry.size) : range;
    const res = await this.content(this.url(this.ep.api, `/files/${encodeURIComponent(f.id)}`, { alt: 'media' }), r);
    if (res.status === 416) { await discard(res); throw new RangeNotSatisfiable(entry.size); }
    if (!res.ok || !res.body) await failure(res, 'download');
    if (res.status !== (r ? 206 : 200)) { await discard(res); throw new Error(`Google Drive download answered ${res.status} to ${r ? 'a' : 'no'} range`); }
    return { entry, stream: fromWeb(res.body!), etag, ...(r ? { range: r } : {}),
      ...(!r && f.md5Checksum ? { hash: { algorithm: 'md5' as const, value: f.md5Checksum.toLowerCase() } } : {}) };
  }

  /**
   * A Drive resumable session: the body goes up in chunks of `chunkBytes`, at most two chunks in memory (an empty
   * file: one multipart request). "Replace"
   * uploads a new revision of the same file; a body that is longer or shorter than declared cancels the session.
   */
  async write(path: string, body: Readable, opts: WriteOptions): Promise<Entry> {
    if (opts.ifMatch !== undefined && opts.onCollision !== 'replace') throw new AppError('VALIDATION');
    // The session is opened with the length; the route passes Content-Length.
    if (opts.size === undefined) throw new AppError('VALIDATION');
    if (opts.size > opts.maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');
    const p = normalizeUserPath(path);
    if (p === '/') throw new AppError('PATH_INVALID');
    const dir = posix.dirname(p);
    let name = posix.basename(p);
    const parentId = await this.folderId(dir, true);
    const existing = await this.child(parentId, name);
    if (opts.ifMatch !== undefined && (!existing || etagOf(existing) !== opts.ifMatch)) throw new AppError('PRECONDITION_FAILED');
    let update: string | undefined;
    if (existing) {
      if (opts.onCollision === 'fail') throw new AppError('FILE_EXISTS', { name });
      if (opts.onCollision === 'keep-both') name = await this.freeName(parentId, name);
      else if (isFolder(existing) || isNative(existing)) await this.setTrashed(existing.id, true); // a new file takes its place
      else update = existing.id;
    }
    const raw = existing && update ? existing.name : name;
    const f = opts.size === 0 ? await this.uploadEmpty(update, raw, parentId, body)
      : await this.sendSession(await this.openSession(update, raw, parentId, opts.size), body, opts.size);
    this.forget(p);
    const listed = await this.listedName(parentId, f);
    return this.entry(f, posix.join(dir, listed), listed);
  }

  private async openSession(update: string | undefined, name: string, parentId: string, size: number): Promise<URL> {
    const res = await this.client.fetch(this.url(this.ep.upload, update ? `/files/${encodeURIComponent(update)}` : '/files',
      { uploadType: 'resumable', fields: FIELDS }), {
      method: update ? 'PATCH' : 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(size),
        'x-upload-content-type': lookupMime(name) },
      body: JSON.stringify(update ? {} : { name, parents: [parentId] }),
    });
    if (!res.ok) await failure(res, 'upload session');
    await discard(res);
    const location = res.headers.get('location');
    const session = location === null ? undefined : new URL(location);
    if (!session || session.origin !== new URL(this.ep.upload).origin) throw new Error('Google Drive answered an upload session outside its upload host');
    return session;
  }

  /**
   * An empty file in one multipart request (#204): a session has no byte range to send for it, and `bytes *\/0` is
   * Drive's status query, which reports progress rather than completing the upload.
   */
  private async uploadEmpty(update: string | undefined, name: string, parentId: string, body: Readable): Promise<DriveFile> {
    for await (const c of body) if ((c as Buffer).length > 0) throw new AppError('SIZE_MISMATCH');
    const boundary = randomBytes(16).toString('hex');
    const meta = JSON.stringify(update ? {} : { name, parents: [parentId] });
    const res = await this.client.fetch(this.url(this.ep.upload, update ? `/files/${encodeURIComponent(update)}` : '/files',
      { uploadType: 'multipart', fields: FIELDS }), {
      method: update ? 'PATCH' : 'POST', redirect: 'manual',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body: `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`
        + `--${boundary}\r\ncontent-type: ${lookupMime(name)}\r\n\r\n\r\n--${boundary}--\r\n`,
    });
    if (!res.ok) await failure(res, 'upload');
    return DriveFile.parse(await res.json());
  }

  private async sendSession(session: URL, body: Readable, size: number): Promise<DriveFile> {
    let persisted = 0; // the bytes Drive has confirmed; every PUT starts here
    // Sends `chunk` from `persisted` on. Drive answers the last byte with the file; before that a 308 whose Range names
    // what it kept, which can be less than was sent (#204). No progress fails rather than resending forever.
    const put = async (chunk: Buffer): Promise<DriveFile | undefined> => {
      const end = persisted + chunk.length;
      const res = await fetch(session, { method: 'PUT', headers: { 'content-range': `bytes ${persisted}-${end - 1}/${size}` },
        body: chunk, redirect: 'manual' });
      if (res.status !== 308) {
        if (!res.ok) await failure(res, 'upload');
        if (end !== size) { await discard(res); throw new Error(`Google Drive finished an upload early (${res.status})`); }
        return DriveFile.parse(await res.json());
      }
      await discard(res);
      const range = res.headers.get('range');
      const m = range === null ? undefined : /^bytes=0-(\d+)$/.exec(range);
      if (range !== null && !m) throw new Error(`Google Drive answered an unreadable upload Range: ${range}`);
      const kept = m ? Number(m[1]) + 1 : 0;
      if (kept <= persisted || kept > end || kept === size) {
        throw new Error(`Google Drive confirmed ${kept} bytes after bytes ${persisted}-${end - 1}/${size}`);
      }
      persisted = kept;
      return undefined;
    };
    try {
      const fresh = () => Buffer.allocUnsafe(Math.min(this.chunkBytes, size - persisted));
      let buf = fresh(); let fill = 0;
      // Sends the buffer; the bytes Drive did not keep move to the front of the next one, so at most two chunks are held.
      const flush = async (): Promise<DriveFile | undefined> => {
        const from = persisted;
        const f = await put(buf.subarray(0, fill));
        if (f) return f;
        const next = fresh();
        fill = buf.copy(next, 0, persisted - from, fill);
        buf = next;
        return undefined;
      };
      for await (const c of body) {
        let data = c as Buffer;
        if (persisted + fill + data.length > size) throw new AppError('SIZE_MISMATCH');
        while (data.length > 0) {
          const take = Math.min(buf.length - fill, data.length);
          data.copy(buf, fill, 0, take);
          fill += take; data = data.subarray(take);
          if (fill === buf.length && persisted + fill < size) await flush();
        }
      }
      if (persisted + fill !== size) throw new AppError('SIZE_MISMATCH');
      for (;;) { const f = await flush(); if (f) return f; }
    } catch (err) {
      await this.cancel(session);
      throw err;
    }
  }

  private async cancel(session: URL): Promise<void> {
    try { await discard(await fetch(session, { method: 'DELETE', redirect: 'manual' })); }
    catch { /* handled: Drive drops an abandoned session after a week; the upload's own error is what the member sees */ }
  }

  async mkdir(path: string): Promise<Entry> {
    const p = normalizeUserPath(path);
    if (p === '/') throw new AppError('FILE_EXISTS', { name: '/' });
    const parentId = await this.folderId(posix.dirname(p), true);
    const name = posix.basename(p);
    if (await this.child(parentId, name)) throw new AppError('FILE_EXISTS', { name });
    const f = await this.createFolder(parentId, name);
    this.forget(p);
    return this.entry(f, p, name);
  }

  // Shared by move and copy: the item, the target folder and the name after the collision policy. "Replace" sends the
  // item in the way to Drive's trash, never deletes it.
  private async prepare(from: string, to: string, onCollision: CollisionPolicy) {
    const f = normalizeUserPath(from); const t = normalizeUserPath(to);
    if (f === '/' || t === '/') throw new AppError('PATH_INVALID');
    if (t.startsWith(`${f}/`)) throw new AppError('TARGET_INSIDE_SOURCE');
    const item = await this.resolve(f);
    const destId = await this.folderId(posix.dirname(t));
    let name = posix.basename(t);
    const existing = await this.child(destId, name);
    let replaced = false;
    if (existing && existing.id !== item.id) {
      if (onCollision === 'fail') throw new AppError('FILE_EXISTS', { name });
      if (onCollision === 'keep-both') name = await this.freeName(destId, name);
      else {
        if (f.startsWith(`${t}/`)) throw new AppError('TARGET_INSIDE_SOURCE');
        await this.setTrashed(existing.id, true);
        replaced = true;
      }
    }
    return { f, t, item, destId, name, same: existing?.id === item.id, replaced };
  }

  async move(from: string, to: string, onCollision: CollisionPolicy): Promise<Entry> {
    if (normalizeUserPath(from) === normalizeUserPath(to)) return this.stat(from);
    const { f, t, item, destId, name } = await this.prepare(from, to, onCollision);
    const moving = !(item.parents ?? []).includes(destId);
    const res = await this.api('PATCH', `/files/${encodeURIComponent(item.id)}`, {
      query: { fields: FIELDS, ...(moving ? { addParents: destId, removeParents: (item.parents ?? []).join(',') } : {}) },
      json: { name: this.rawName(item, name) } });
    const moved = DriveFile.parse(await res.json());
    this.forget(f); this.forget(t);
    const listed = await this.listedName(destId, moved);
    return this.entry(moved, posix.join(posix.dirname(t), listed), listed);
  }

  async copy(from: string, to: string, onCollision: CollisionPolicy): Promise<Entry> {
    const { t, item, destId, name, same } = await this.prepare(from, to, onCollision);
    // Onto its own name: "fail" asks (FILE_EXISTS), "keep both" duplicates, "replace" leaves it as it is.
    if (same && onCollision === 'fail') throw new AppError('FILE_EXISTS', { name });
    if (same && onCollision === 'replace') return this.stat(t);
    const target = same ? await this.freeName(destId, name) : name;
    const copied = await this.copyItem(item, destId, this.rawName(item, target));
    this.forget(posix.join(posix.dirname(t), target));
    const listed = await this.listedName(destId, copied);
    return this.entry(copied, posix.join(posix.dirname(t), listed), listed);
  }

  // Files are copied by Drive itself (no bytes pass the shard); a folder is made anew and its items copied into it.
  private async copyItem(item: DriveFile, parentId: string, name: string): Promise<DriveFile> {
    if (!isFolder(item)) {
      const res = await this.api('POST', `/files/${encodeURIComponent(item.id)}/copy`, { query: { fields: FIELDS }, json: { name, parents: [parentId] } });
      return DriveFile.parse(await res.json());
    }
    const dir = await this.createFolder(parentId, name);
    for (const child of await this.children(item.id)) await this.copyItem(child, dir.id, child.name);
    return dir;
  }

  /** All or nothing: every path is resolved first, and items already trashed come back if a later one fails. */
  async delete(paths: readonly string[]): Promise<void> {
    const all = paths.map(normalizeUserPath);
    if (all.includes('/')) throw new AppError('PATH_INVALID');
    const top = [...new Set(all)].filter((p) => !all.some((o) => p.startsWith(`${o}/`)));
    const items = [];
    for (const p of top) items.push(await this.resolve(p));
    const done: string[] = [];
    try {
      for (const f of items) { await this.setTrashed(f.id, true); done.push(f.id); }
    } catch (err) {
      for (const id of done.reverse()) {
        try { await this.setTrashed(id, false); }
        catch (undo) { throw new AggregateError([err, undo], 'Google Drive delete failed and could not be undone', { cause: undo }); }
      }
      throw err;
    } finally {
      for (const p of top) this.forget(p);
    }
  }

  async quota(): Promise<{ used: number; total?: number }> {
    const res = await this.api('GET', '/about', { query: { fields: 'storageQuota(limit,usage)' } });
    const q = z.object({ storageQuota: z.object({ limit: z.string().optional(), usage: z.string().optional() }) }).parse(await res.json()).storageQuota;
    // No limit: an unlimited (e.g. organisation) account.
    return { used: Number(q.usage ?? 0), ...(q.limit !== undefined ? { total: Number(q.limit) } : {}) };
  }

  async revisions(path: string): Promise<Revision[]> {
    const f = await this.resolve(normalizeUserPath(path));
    if (isFolder(f)) throw new AppError('IS_A_DIRECTORY');
    const Revisions = z.object({ revisions: z.array(z.object({ id: z.string(), modifiedTime: z.string(), size: z.string().optional() })).optional(),
      nextPageToken: z.string().optional() });
    const out: Revision[] = [];
    let pageToken: string | undefined;
    do {
      const page = Revisions.parse(await (await this.api('GET', `/files/${encodeURIComponent(f.id)}/revisions`, {
        query: { fields: 'nextPageToken,revisions(id,modifiedTime,size)', ...(pageToken !== undefined ? { pageToken } : {}) } })).json());
      for (const r of page.revisions ?? []) out.push({ id: r.id, modified: new Date(r.modifiedTime).toISOString(), ...(r.size !== undefined ? { size: Number(r.size) } : {}) });
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    // Drive lists oldest first; the last is the file as it is now. Drive's API has no restore (DECISIONS, #154).
    const last = out.at(-1);
    if (last) last.current = true;
    return out;
  }

  /** Drive's own thumbnail at the requested size, fetched by the server and re-encoded as WebP; its URL never leaves. */
  async thumbnail(path: string, size: ThumbSize): Promise<Readable | null> {
    const f = await this.resolve(normalizeUserPath(path));
    if (isFolder(f) || f.thumbnailLink === undefined) return null;
    const u = new URL(f.thumbnailLink);
    if (!this.ep.thumbnailHost(u)) throw new Error(`Google Drive gave a thumbnail on ${u.host}, which is not one of its thumbnail hosts`);
    // The size is `=s220` at the end of the path (stored files) or `sz=s220` in the query (Google Docs); a link in
    // neither shape is fetched as it is and resized below.
    u.pathname = u.pathname.replace(/=s\d+$/, `=s${size}`);
    u.search = u.search.replace(/([?&]sz=)s\d+(?=&|$)/, `$1s${size}`);
    const res = await this.content(u);
    if (res.status === 404) { await discard(res); return null; }
    if (!res.ok || !res.body) await failure(res, 'thumbnail');
    const out = sharp().rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp();
    const input = fromWeb(res.body!);
    input.on('error', (e) => out.destroy(e));
    return input.pipe(out);
  }

  /**
   * Drive's `name contains` matches word prefixes; the results are narrowed to names that contain the query anywhere,
   * ignoring case, like the home's search. Items outside My Drive (no path from its root) are left out.
   */
  async search(query: string, limit: number): Promise<Entry[]> {
    const needle = query.normalize('NFC').toLowerCase();
    const root = await this.rootId();
    const folders = new Map<string, string | null>([[root, '/']]);
    const pathOfFolder = async (id: string, depth: number): Promise<string | null> => {
      const known = folders.get(id);
      if (known !== undefined) return known;
      const f = await this.file(id);
      const parent = f.parents?.[0];
      const above = !f.trashed && parent !== undefined && depth < 64 ? await pathOfFolder(parent, depth + 1) : null;
      const path = above === null ? null : posix.join(above, await this.listedName(parent!, f));
      folders.set(id, path);
      return path;
    };
    const out: Entry[] = [];
    for await (const page of this.pages(`name contains ${quote(query)} and trashed = false`, 100)) {
      for (const f of page) {
        if (!plainName(f).name.toLowerCase().includes(needle) || f.parents?.[0] === undefined) continue;
        const dir = await pathOfFolder(f.parents[0], 0);
        if (dir === null) continue;
        const name = await this.listedName(f.parents[0], f);
        out.push(this.entry(f, posix.join(dir, name), name));
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}

/**
 * The Google Drive provider. Endpoints are Google's unless code (the tests' fake Drive) passes others; client id and
 * secret come from config (`FILES_GOOGLE_CLIENT_ID`/`_SECRET`). `access_type=offline` and `prompt=consent` make Google
 * issue a refresh token on every consent, also when the account was connected before.
 */
export function googleDriveProvider(creds: { clientId: string; clientSecret: string },
  o: { endpoints?: DriveEndpoints; chunkBytes?: number } = {}): Provider {
  const ep = o.endpoints ?? GOOGLE_DRIVE_ENDPOINTS;
  const chunk = o.chunkBytes ?? UPLOAD_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunk) || chunk <= 0 || chunk % CHUNK_UNIT !== 0) throw new Error('chunkBytes must be a positive multiple of 256 KiB');
  return {
    id: 'google-drive', name: 'Google Drive', authorizationEndpoint: ep.authorization, tokenEndpoint: ep.token,
    clientId: creds.clientId, clientSecret: creds.clientSecret, scopes: [DRIVE_SCOPE], pkce: true,
    authorizationParams: { access_type: 'offline', prompt: 'consent' },
    async account(client) {
      const res = await client.fetch(`${ep.api}/about?fields=${encodeURIComponent('user(permissionId,emailAddress)')}`, { redirect: 'manual' });
      if (!res.ok) await failure(res, 'about');
      const { user } = z.object({ user: z.object({ permissionId: z.string().min(1), emailAddress: z.string().optional() }) }).parse(await res.json());
      return { id: user.permissionId, label: user.emailAddress ?? user.permissionId };
    },
    backend: (client) => new GoogleDriveBackend(client, ep, chunk),
  };
}
