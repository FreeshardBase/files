import { posix } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import sharp from 'sharp';
import { z } from 'zod';
import { GraphId, type CollisionPolicy, type Entry, type Library, type Site, type ThumbSize } from '@files/shared';
import { AppError } from '../errors.ts';
import { RangeNotSatisfiable, type ByteRange, type Revision, type StorageBackend, type WriteOptions } from '../storage/backend.ts';
import { lookupMime } from '../storage/mime.ts';
import { normalizeUserPath } from '../storage/resolveInRoot.ts';
import type { LibraryPicker, OAuthClient, Provider } from './oauth.ts';

// Microsoft Graph (#151): one `StorageBackend` for OneDrive (the account's own drive, `/me/drive`) and SharePoint
// document libraries (`/drives/{id}`, picked after the consent), live, through the connection's OAuthClient (refresh,
// backoff). Items are addressed by path (`root:/a/b`) or by id; their names ignore case, so names are compared
// lowercased. Content, upload sessions and copy monitors live on pre-signed URLs, which are only ever called on
// Microsoft's content hosts and without the bearer token.

/** Where the server talks to Microsoft. Fixed here, never taken from a request (spec §3.7); the tenant comes from config. */
export type GraphEndpoints = {
  authorization: string; token: string;
  /** The Graph API root (`…/v1.0`). Listings follow `@odata.nextLink` only below it. */
  api: string;
  /** Hosts of pre-signed URLs: content and thumbnail redirects, upload sessions, copy monitors. Nothing else is called. */
  contentHost(u: URL): boolean;
};
const CONTENT_HOST_SUFFIXES = ['.sharepoint.com', '.1drv.com', '.livefilestore.com', '.onedrive.com'];
export const graphEndpoints = (tenant: string): GraphEndpoints => ({
  authorization: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
  token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
  api: 'https://graph.microsoft.com/v1.0',
  contentHost: (u) => u.protocol === 'https:' && CONTENT_HOST_SUFFIXES.some((s) => u.hostname.endsWith(s)),
});
/** The account's own files (DECISIONS #151). */
export const ONEDRIVE_SCOPES = ['offline_access', 'User.Read', 'Files.ReadWrite'] as const;
/** Files of every library the member can reach, and finding sites for the picker. */
export const SHAREPOINT_SCOPES = ['offline_access', 'User.Read', 'Files.ReadWrite.All', 'Sites.Read.All'] as const;
/** Graph wants upload-session chunks in multiples of 320 KiB, at most 60 MiB each. One chunk is all an upload holds in memory. */
export const CHUNK_UNIT = 320 * 1024;
export const UPLOAD_CHUNK_BYTES = 32 * CHUNK_UNIT; // 10 MiB
const MAX_CHUNK_BYTES = 60 * 1024 * 1024;
/** Entries per listing page Graph is asked for; the listing follows `@odata.nextLink` to the end. */
const PAGE_SIZE = 1000;
const MAX_REDIRECTS = 3;
/** Graph's thumbnail sizes: the smallest one that covers the asked size (medium is 176 px, large 800 px). */
const thumbTag = (size: ThumbSize) => (size <= 176 ? 'medium' : 'large');
/** An asynchronous copy is polled after 0.5, 1, 2 s and then every 2 s, for at most ten minutes. */
const POLL_MS = 500;
const MAX_POLL_MS = 2000;
const COPY_TIMEOUT_MS = 10 * 60 * 1000;

const Item = z.object({
  id: z.string().min(1), name: z.string(), eTag: z.string().optional(), size: z.number().nonnegative().optional(),
  lastModifiedDateTime: z.string(),
  file: z.object({}).optional(), folder: z.object({}).optional(), root: z.object({}).optional(),
  parentReference: z.object({ id: z.string().optional(), driveId: z.string().optional() }).optional(),
});
type Item = z.infer<typeof Item>;
const Page = z.object({ value: z.array(Item), '@odata.nextLink': z.string().optional() });
const GraphError = z.object({ error: z.object({ code: z.string() }) });
const Monitor = z.object({ status: z.string(), error: z.object({ code: z.string().optional() }).optional() });

const lower = (p: string) => p.toLowerCase();
const inside = (p: string, dir: string) => lower(p).startsWith(`${lower(dir)}/`);
const isFolder = (i: Item) => i.folder !== undefined || i.root !== undefined;
const etagOf = (i: Item) => `"${(i.eTag ?? i.id).replace(/"/g, '')}"`;
const fromWeb = (body: ReadableStream<Uint8Array>) => Readable.fromWeb(body as WebReadableStream<Uint8Array>);
const discard = async (res: Response) => { await res.body?.cancel(); };
/** A path as Graph's path addressing wants it: every segment percent-encoded. */
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const isRedirect = (res: Response) => res.status >= 300 && res.status < 400;

/**
 * Maps a Graph error answer to an error code: `{ error: { code } }` with the HTTP status. Anything unexpected is a
 * plain Error (500, logged) with the status and Graph's code only, never a path or a token.
 */
async function failure(res: Response, what: string, name?: string): Promise<never> {
  const text = await res.text();
  let code: string;
  try { code = GraphError.parse(JSON.parse(text)).error.code; }
  catch { code = ''; } // handled: a body that is not Graph's JSON error leaves the status to decide
  if (res.status === 404 || code === 'itemNotFound') throw new AppError('NOT_FOUND');
  if (res.status === 409 || code === 'nameAlreadyExists') throw new AppError('FILE_EXISTS', name !== undefined ? { name } : undefined);
  if (res.status === 412 || code === 'resourceModified') throw new AppError('PRECONDITION_FAILED');
  if (res.status === 507 || code === 'quotaLimitReached' || code === 'insufficientStorage') throw new AppError('STORAGE_FULL');
  if (res.status === 403 || code === 'accessDenied') throw new AppError('FORBIDDEN');
  throw new Error(`Microsoft Graph ${what} answered ${res.status}${code ? ` (${code})` : ''}`);
}

export class GraphBackend implements StorageBackend {
  /** `…/me/drive` or `…/drives/{id}`: every item request is below it. */
  private base: string;

  constructor(private client: OAuthClient, private ep: GraphEndpoints, private chunkBytes: number, drive: string) {
    this.base = drive === '' ? `${ep.api}/me/drive` : `${ep.api}/drives/${GraphId.parse(drive)}`;
  }

  // --- requests ---------------------------------------------------------------------------------------------------

  /** An API request; any answer but 2xx becomes an error. Redirects are never followed here. */
  private async call(method: string, url: string, what: string, o: { json?: unknown; headers?: Record<string, string>; name?: string } = {}): Promise<Response> {
    const res = await this.client.fetch(url, { method, redirect: 'manual',
      headers: { ...(o.json !== undefined ? { 'content-type': 'application/json' } : {}), ...o.headers },
      ...(o.json !== undefined ? { body: JSON.stringify(o.json) } : {}) });
    if (!res.ok) await failure(res, what, o.name);
    return res;
  }

  /** The URL of the item at `p`, plus an action (`/children`, `/content`, …) addressed through the path. */
  private at(p: string, action = ''): string {
    return p === '/' ? `${this.base}/root${action}` : `${this.base}/root:${encPath(p)}${action ? `:${action}` : ''}`;
  }
  private byId(id: string, action = ''): string { return `${this.base}/items/${encodeURIComponent(id)}${action}`; }

  /** A URL Graph handed out for a pre-signed request; anything off Microsoft's content hosts fails before it is called. */
  private presigned(location: string | null, what: string): URL {
    const u = location === null ? undefined : new URL(location);
    if (!u || !this.ep.contentHost(u)) throw new Error(`Microsoft Graph gave a ${what} URL on ${u?.host ?? 'nowhere'}, which is not one of its content hosts`);
    return u;
  }

  /**
   * Content bytes: Graph answers `/content` with a 302 to a pre-signed URL. It is followed here, only to the content
   * hosts and without the bearer token, and the answer is handed back unread.
   */
  private async content(url: string, range?: ByteRange): Promise<Response> {
    const headers: Record<string, string> = range ? { range: `bytes=${range.start}-${range.end}` } : {};
    let res = await this.client.fetch(url, { headers, redirect: 'manual' });
    for (let hops = 0; isRedirect(res); hops++) {
      const location = res.headers.get('location');
      await discard(res);
      if (hops >= MAX_REDIRECTS) throw new Error('Microsoft Graph redirected a download too often');
      res = await fetch(this.presigned(location, 'download'), { headers, redirect: 'manual' });
    }
    return res;
  }

  private async meta(p: string): Promise<Item> {
    return Item.parse(await (await this.call('GET', this.at(p), 'item')).json());
  }
  private async metaOrNone(p: string): Promise<Item | undefined> {
    return this.meta(p).catch((e: unknown) => {
      if (e instanceof AppError && e.code === 'NOT_FOUND') return undefined; // handled: nothing is there
      throw e;
    });
  }
  private async folderAt(p: string): Promise<Item> {
    const i = await this.meta(p);
    if (!isFolder(i)) throw new AppError('NOT_A_DIRECTORY');
    return i;
  }

  private entry(i: Item, path: string): Entry {
    const modified = new Date(i.lastModifiedDateTime).toISOString();
    if (isFolder(i)) return { name: path === '/' ? '/' : i.name, path, type: 'directory', size: 0, modified };
    return { name: i.name, path, type: 'file', size: i.size ?? 0, modified, mime: lookupMime(i.name) };
  }
  /** The entry of an item that now lives in `dir`, under Graph's name for it (which carries its case). */
  private placed(i: Item, dir: string): Entry { return this.entry(i, posix.join(dir, i.name)); }

  /** Every child of the folder, following `@odata.nextLink`, which is only ever followed below the Graph API. */
  private async children(folder: Item): Promise<Item[]> {
    const api = new URL(this.ep.api);
    const out: Item[] = [];
    let url: string | undefined = `${this.byId(folder.id, '/children')}?$top=${PAGE_SIZE}`;
    while (url !== undefined) {
      const page = Page.parse(await (await this.call('GET', url, 'list')).json());
      out.push(...page.value);
      url = page['@odata.nextLink'];
      if (url !== undefined) {
        const next = new URL(url);
        if (next.origin !== api.origin || !next.pathname.startsWith(`${api.pathname}/`)) {
          throw new Error(`Microsoft Graph gave a nextLink on ${next.host}, outside its API`);
        }
      }
    }
    return out;
  }

  /** `name (n).ext` with the lowest n that no item of the folder holds, ignoring case like OneDrive does. */
  private async freeName(dir: string, name: string): Promise<string> {
    const taken = new Set((await this.children(await this.folderAt(dir))).map((i) => lower(i.name)));
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 1; ; n++) if (!taken.has(lower(`${stem} (${n})${ext}`))) return `${stem} (${n})${ext}`;
  }

  private async createFolder(parentId: string, name: string): Promise<Item> {
    const res = await this.call('POST', this.byId(parentId, '/children'), 'create folder',
      { json: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }, name });
    return Item.parse(await res.json());
  }
  /** The folder at `p`, with missing folders on the way created, as in the home. */
  private async ensureFolder(p: string): Promise<Item> {
    const i = await this.metaOrNone(p);
    if (i) { if (!isFolder(i)) throw new AppError('NOT_A_DIRECTORY'); return i; }
    return this.createFolder((await this.ensureFolder(posix.dirname(p))).id, posix.basename(p));
  }

  /** Into the drive's recycle bin, from where the member can restore it. `permanentDelete` is never sent. */
  private async remove(i: Item): Promise<void> {
    await discard(await this.call('DELETE', this.byId(i.id), 'delete'));
  }

  // --- StorageBackend ---------------------------------------------------------------------------------------------

  async list(path: string): Promise<{ entries: Entry[] }> {
    const dir = normalizeUserPath(path);
    const items = await this.children(await this.folderAt(dir));
    return { entries: items.map((i) => this.placed(i, dir)) };
  }

  async stat(path: string): Promise<Entry> {
    const p = normalizeUserPath(path);
    const i = await this.meta(p);
    return p === '/' ? this.entry(i, '/') : this.placed(i, posix.dirname(p));
  }

  async read(path: string, range?: ByteRange | ((size: number) => ByteRange | undefined)) {
    const p = normalizeUserPath(path);
    const i = await this.meta(p);
    if (isFolder(i)) throw new AppError('IS_A_DIRECTORY');
    const size = i.size ?? 0;
    const r = typeof range === 'function' ? range(size) : range;
    if (r && (r.start >= size || r.start > r.end)) throw new RangeNotSatisfiable(size);
    // By id, so the bytes are those of the item just looked up even if the path changes meanwhile.
    const res = await this.content(this.byId(i.id, '/content'), r);
    if (res.status === 416) { await discard(res); throw new RangeNotSatisfiable(size); }
    if (!res.ok || !res.body) await failure(res, 'download');
    if (res.status !== (r ? 206 : 200)) { await discard(res); throw new Error(`Microsoft Graph download answered ${res.status} to ${r ? 'a' : 'no'} range`); }
    return { entry: this.placed(i, posix.dirname(p)), stream: fromWeb(res.body!), etag: etagOf(i), ...(r ? { range: r } : {}) };
  }

  /**
   * An upload session (`createUploadSession`): the body goes up in chunks of `chunkBytes` with `Content-Range`, one chunk
   * in memory at a time, to the session's pre-signed URL. The conflict behaviour is `fail`, or `replace` for replace
   * (a new version of the file) and for If-Match, which Graph checks itself. A body longer or shorter than declared
   * cancels the session, so nothing is created. A session needs the length up front.
   */
  async write(path: string, body: Readable, opts: WriteOptions): Promise<Entry> {
    if (opts.ifMatch !== undefined && opts.onCollision !== 'replace') throw new AppError('VALIDATION');
    if (opts.size === undefined) throw new AppError('VALIDATION');
    if (opts.size > opts.maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');
    const size = opts.size;
    const p = normalizeUserPath(path);
    if (p === '/') throw new AppError('PATH_INVALID');
    const dir = posix.dirname(p);
    let name = posix.basename(p);
    const existing = await this.metaOrNone(p);
    let conflict = 'fail';
    const headers: Record<string, string> = {};
    if (opts.ifMatch !== undefined) {
      if (!existing || isFolder(existing) || etagOf(existing) !== opts.ifMatch) throw new AppError('PRECONDITION_FAILED');
      conflict = 'replace';
      headers['if-match'] = existing.eTag ?? '';
    } else if (existing) {
      if (opts.onCollision === 'fail') throw new AppError('FILE_EXISTS', { name });
      if (opts.onCollision === 'keep-both') name = await this.freeName(dir, name);
      else if (isFolder(existing)) await this.remove(existing); // a file takes the folder's place
      else conflict = 'replace'; // Graph keeps the old content as a version
    }
    await this.ensureFolder(dir);
    const target = posix.join(dir, name);

    if (size === 0) {
      // An empty file has no range to send in a session: it goes up as one empty request.
      for await (const c of body) if ((c as Buffer).length > 0) throw new AppError('SIZE_MISMATCH');
      const res = await this.call('PUT', `${this.at(target, '/content')}?@microsoft.graph.conflictBehavior=${conflict}`, 'upload',
        { headers, name });
      return this.placed(Item.parse(await res.json()), dir);
    }

    const opened = await this.call('POST', this.at(target, '/createUploadSession'), 'upload session',
      { json: { item: { '@microsoft.graph.conflictBehavior': conflict } }, headers, name });
    const session = this.presigned(z.object({ uploadUrl: z.string() }).parse(await opened.json()).uploadUrl, 'upload session');
    return this.placed(await this.sendSession(session, body, size, name), dir);
  }

  private async sendSession(session: URL, body: Readable, size: number, name: string): Promise<Item> {
    let sent = 0;
    const put = async (chunk: Buffer, last: boolean): Promise<Item | undefined> => {
      const res = await fetch(session, { method: 'PUT', redirect: 'manual', body: chunk,
        headers: { 'content-range': `bytes ${sent}-${sent + chunk.length - 1}/${size}` } });
      sent += chunk.length;
      if (!last) {
        if (res.status !== 202) { if (!res.ok) await failure(res, 'upload'); await discard(res); throw new Error(`Microsoft Graph finished an upload early (${res.status})`); }
        await discard(res);
        return undefined;
      }
      if (!res.ok) await failure(res, 'upload commit', name);
      return Item.parse(await res.json());
    };
    try {
      // One buffer for the whole upload: a PUT has sent its body once Graph answers, so the next chunk may overwrite it.
      const buf = Buffer.allocUnsafe(Math.max(1, Math.min(this.chunkBytes, size)));
      let fill = 0;
      for await (const c of body) {
        let data = c as Buffer;
        if (sent + fill + data.length > size) throw new AppError('SIZE_MISMATCH');
        while (data.length > 0) {
          const take = Math.min(buf.length - fill, data.length);
          data.copy(buf, fill, 0, take);
          fill += take; data = data.subarray(take);
          if (fill === buf.length && sent + fill < size) { await put(buf, false); fill = 0; }
        }
      }
      if (sent + fill !== size) throw new AppError('SIZE_MISMATCH');
      return (await put(buf.subarray(0, fill), true))!;
    } catch (err) {
      await this.cancel(session);
      throw err;
    }
  }

  private async cancel(session: URL): Promise<void> {
    try { await discard(await fetch(session, { method: 'DELETE', redirect: 'manual' })); }
    catch { /* handled: Graph drops an abandoned session when it expires; the upload's own error is what the member sees */ }
  }

  async mkdir(path: string): Promise<Entry> {
    const p = normalizeUserPath(path);
    if (p === '/') throw new AppError('FILE_EXISTS', { name: '/' });
    const parent = await this.folderAt(posix.dirname(p));
    return this.placed(await this.createFolder(parent.id, posix.basename(p)), posix.dirname(p));
  }

  async move(from: string, to: string, onCollision: CollisionPolicy): Promise<Entry> {
    const f = normalizeUserPath(from); let t = normalizeUserPath(to);
    if (f === t) return this.stat(f);
    if (f === '/' || t === '/') throw new AppError('PATH_INVALID');
    if (inside(t, f)) throw new AppError('TARGET_INSIDE_SOURCE');
    const item = await this.meta(f);
    // A rename that only changes the case is the item itself in the way, never a collision; Graph renames it as it is.
    if (lower(f) !== lower(t)) t = await this.clear(f, t, onCollision);
    const parent = await this.folderAt(posix.dirname(t));
    const res = await this.call('PATCH', this.byId(item.id), 'move',
      { json: { name: posix.basename(t), parentReference: { id: parent.id } }, name: posix.basename(t) });
    return this.placed(Item.parse(await res.json()), posix.dirname(t));
  }

  /** Makes room at `t` under the policy: FILE_EXISTS, a free name, or the item in the way into the recycle bin. */
  private async clear(f: string, t: string, onCollision: CollisionPolicy, existing?: Item): Promise<string> {
    const there = existing ?? await this.metaOrNone(t);
    if (!there) return t;
    if (onCollision === 'fail') throw new AppError('FILE_EXISTS', { name: posix.basename(t) });
    if (onCollision === 'keep-both') return posix.join(posix.dirname(t), await this.freeName(posix.dirname(t), posix.basename(t)));
    if (inside(f, t)) throw new AppError('TARGET_INSIDE_SOURCE');
    await this.remove(there);
    return t;
  }

  /**
   * Graph copies on its side, asynchronously: the copy answers 202 with a monitor URL, which is polled (pre-signed, on
   * the content hosts) until the copy is done; then the new item is looked up by its path.
   */
  async copy(from: string, to: string, onCollision: CollisionPolicy): Promise<Entry> {
    const f = normalizeUserPath(from); let t = normalizeUserPath(to);
    if (f === '/' || t === '/') throw new AppError('PATH_INVALID');
    if (inside(t, f)) throw new AppError('TARGET_INSIDE_SOURCE');
    const item = await this.meta(f);
    // Onto its own name (in any case): "fail" asks, "replace" leaves it as it is, "keep both" duplicates.
    if (lower(f) === lower(t)) {
      if (onCollision === 'replace') return this.stat(f);
      t = await this.clear(f, t, onCollision, item);
    } else t = await this.clear(f, t, onCollision);
    const parent = await this.folderAt(posix.dirname(t));
    const driveId = item.parentReference?.driveId ?? parent.parentReference?.driveId;
    if (driveId === undefined) throw new Error('Microsoft Graph named no drive for a copy');
    const name = posix.basename(t);
    const res = await this.call('POST', this.byId(item.id, '/copy'), 'copy', { json: { parentReference: { driveId, id: parent.id }, name }, name });
    await discard(res);
    await this.monitor(this.presigned(res.headers.get('location'), 'copy monitor'), name);
    return this.stat(t);
  }

  private async monitor(url: URL, name: string): Promise<void> {
    const clock = this.client.clock;
    const started = clock.now();
    for (let n = 0; ; n++) {
      const res = await fetch(url, { redirect: 'manual' });
      if (isRedirect(res)) { await discard(res); return; } // done: Graph points at the new item
      if (!res.ok) await failure(res, 'copy monitor');
      const s = Monitor.parse(await res.json());
      if (s.status === 'completed') return;
      if (s.status === 'failed' || s.status === 'deleteFailed') {
        if (s.error?.code === 'nameAlreadyExists') throw new AppError('FILE_EXISTS', { name });
        throw new Error(`Microsoft Graph copy failed${s.error?.code ? ` (${s.error.code})` : ''}`);
      }
      if (clock.now() - started > COPY_TIMEOUT_MS) throw new AppError('PROVIDER_UNAVAILABLE');
      await clock.sleep(Math.min(MAX_POLL_MS, POLL_MS * 2 ** n));
    }
  }

  /**
   * Every path is looked up before anything is deleted, so a missing one changes nothing; a path beneath another one (in
   * any case) goes with it. Graph has no transaction: a delete that fails halfway leaves the items before it in the
   * recycle bin (DECISIONS #151).
   */
  async delete(paths: readonly string[]): Promise<void> {
    const all = paths.map(normalizeUserPath);
    if (all.includes('/')) throw new AppError('PATH_INVALID');
    const seen = new Set<string>();
    const top = all.filter((p) => !all.some((o) => inside(p, o)) && !seen.has(lower(p)) && seen.add(lower(p)));
    const items: Item[] = [];
    for (const p of top) items.push(await this.meta(p));
    for (const i of items) await this.remove(i);
  }

  async quota(): Promise<{ used: number; total?: number }> {
    const r = z.object({ quota: z.object({ used: z.number(), total: z.number().optional() }) })
      .parse(await (await this.call('GET', this.base, 'drive')).json());
    return { used: r.quota.used, ...(r.quota.total !== undefined ? { total: r.quota.total } : {}) };
  }

  /** The file's versions; Graph answers newest first. */
  async revisions(path: string): Promise<Revision[]> {
    const i = await this.meta(normalizeUserPath(path));
    if (isFolder(i)) throw new AppError('IS_A_DIRECTORY');
    const r = z.object({ value: z.array(z.object({ id: z.string(), lastModifiedDateTime: z.string(), size: z.number().optional() })) })
      .parse(await (await this.call('GET', this.byId(i.id, '/versions'), 'versions')).json());
    return r.value.map((v) => ({ id: v.id, modified: new Date(v.lastModifiedDateTime).toISOString(), ...(v.size !== undefined ? { size: v.size } : {}) }))
      .reverse();
  }

  /** Graph's own thumbnail, fetched by the server from the content hosts and re-encoded as WebP; null where it has none. */
  async thumbnail(path: string, size: ThumbSize): Promise<Readable | null> {
    const p = normalizeUserPath(path);
    if (p === '/') return null;
    const res = await this.content(this.at(p, `/thumbnails/0/${thumbTag(size)}/content`));
    if (res.status === 404) { await discard(res); return null; }
    if (!res.ok || !res.body) await failure(res, 'thumbnail');
    const out = sharp().rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp();
    const input = fromWeb(res.body!);
    input.on('error', (e) => out.destroy(e));
    return input.pipe(out);
  }

  /**
   * Graph's drive search matches words and content; its results are narrowed to names that contain the query anywhere,
   * ignoring case, like the home's search. A result carries no reliable path, so each one gets its path by walking its
   * parents to the drive's root; anything that does not reach it (an item of another drive) is left out.
   */
  async search(query: string, limit: number): Promise<Entry[]> {
    const needle = query.normalize('NFC').toLowerCase();
    const folders = new Map<string, string | undefined>(); // folder id → its path in this drive
    const out: Entry[] = [];
    const api = new URL(this.ep.api);
    let url: string | undefined = `${this.base}/root/search(q='${encodeURIComponent(query.replace(/'/g, "''"))}')`;
    while (url !== undefined) {
      const page = Page.parse(await (await this.call('GET', url, 'search')).json());
      for (const i of page.value) {
        if (!i.name.normalize('NFC').toLowerCase().includes(needle) || i.parentReference?.id === undefined) continue;
        const dir = await this.folderPath(i.parentReference.id, folders);
        if (dir === undefined) continue;
        out.push(this.placed(i, dir));
        if (out.length >= limit) return out;
      }
      url = page['@odata.nextLink'];
      if (url !== undefined && (new URL(url).origin !== api.origin || !new URL(url).pathname.startsWith(`${api.pathname}/`))) {
        throw new Error('Microsoft Graph gave a search nextLink outside its API');
      }
    }
    return out;
  }

  private async folderPath(id: string, known: Map<string, string | undefined>): Promise<string | undefined> {
    if (known.has(id)) return known.get(id);
    const i = await this.call('GET', this.byId(id), 'item').then(async (r) => Item.parse(await r.json()), (e: unknown) => {
      if (e instanceof AppError && e.code === 'NOT_FOUND') return undefined; // handled: not an item of this drive
      throw e;
    });
    let path: string | undefined;
    if (i?.root !== undefined) path = '/';
    else if (i?.parentReference?.id !== undefined) {
      const parent = await this.folderPath(i.parentReference.id, known);
      path = parent === undefined ? undefined : posix.join(parent, i.name);
    }
    known.set(id, path);
    return path;
  }
}

/** The SharePoint picker: sites by name (Graph's site search), a site's document libraries, and a picked one's label. */
function libraryPicker(ep: GraphEndpoints): LibraryPicker {
  const get = async (client: OAuthClient, url: string, what: string) => {
    const res = await client.fetch(url, { redirect: 'manual' });
    if (!res.ok) await failure(res, what);
    return res.json() as Promise<unknown>;
  };
  const SiteJson = z.object({ id: z.string(), displayName: z.string().optional(), name: z.string().optional(), webUrl: z.string() });
  const libraries = async (client: OAuthClient, site: string): Promise<Library[]> => {
    const r = z.object({ value: z.array(z.object({ id: z.string(), name: z.string(), driveType: z.string().optional() })) })
      .parse(await get(client, `${ep.api}/sites/${GraphId.parse(site)}/drives`, 'site libraries'));
    return r.value.filter((d) => d.driveType === 'documentLibrary' && GraphId.safeParse(d.id).success).map((d) => ({ id: d.id, name: d.name }));
  };
  return {
    // Ids that could not be picked (outside GraphId) are not offered.
    async sites(client, query) {
      const r = z.object({ value: z.array(SiteJson) })
        .parse(await get(client, `${ep.api}/sites?search=${encodeURIComponent(query.trim() || '*')}`, 'site search'));
      return r.value.filter((s) => GraphId.safeParse(s.id).success)
        .map((s): Site => ({ id: s.id, name: s.displayName ?? s.name ?? s.webUrl, url: s.webUrl }));
    },
    libraries,
    async label(client, site, library) {
      const s = SiteJson.parse(await get(client, `${ep.api}/sites/${GraphId.parse(site)}`, 'site'));
      const lib = (await libraries(client, site)).find((l) => l.id === library);
      if (!lib) throw new AppError('NOT_FOUND');
      return `${s.displayName ?? s.name ?? s.webUrl} / ${lib.name}`;
    },
  };
}

/**
 * The OneDrive and SharePoint providers over one Azure app registration. Endpoints are Microsoft's for the configured
 * tenant unless code (the tests' fake Graph) passes others; the client id and secret come from config
 * (`FILES_GRAPH_CLIENT_ID`/`_SECRET`). `offline_access` makes Microsoft issue a refresh token, which it rotates.
 */
export function graphProviders(creds: { clientId: string; clientSecret: string; tenant: string },
  o: { endpoints?: GraphEndpoints; chunkBytes?: number } = {}): Provider[] {
  const ep = o.endpoints ?? graphEndpoints(creds.tenant);
  const chunk = o.chunkBytes ?? UPLOAD_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunk) || chunk <= 0 || chunk % CHUNK_UNIT !== 0 || chunk > MAX_CHUNK_BYTES) {
    throw new Error('chunkBytes must be a multiple of 320 KiB, at most 60 MiB');
  }
  const common = { authorizationEndpoint: ep.authorization, tokenEndpoint: ep.token, clientId: creds.clientId,
    clientSecret: creds.clientSecret, pkce: true,
    async account(client: OAuthClient) {
      const res = await client.fetch(`${ep.api}/me`, { redirect: 'manual' });
      if (!res.ok) await failure(res, 'me');
      const me = z.object({ id: z.string().min(1), mail: z.string().nullish(), userPrincipalName: z.string().nullish() }).parse(await res.json());
      return { id: me.id, label: me.mail ?? me.userPrincipalName ?? me.id };
    } };
  return [
    { ...common, id: 'onedrive', name: 'OneDrive', scopes: ONEDRIVE_SCOPES, backend: (client) => new GraphBackend(client, ep, chunk, '') },
    { ...common, id: 'sharepoint', name: 'SharePoint', scopes: SHAREPOINT_SCOPES, libraries: libraryPicker(ep),
      backend: (client, drive) => {
        if (drive === '') throw new Error('a SharePoint connection has no files before its library is picked');
        return new GraphBackend(client, ep, chunk, drive);
      } },
  ];
}
