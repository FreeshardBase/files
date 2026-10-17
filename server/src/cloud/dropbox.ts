import { posix } from 'node:path';
import { randomBytes } from 'node:crypto';
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

// Dropbox (#150): a `StorageBackend` over the Dropbox API v2, live, through the connection's OAuthClient (refresh,
// backoff). Dropbox addresses items by path, and its paths ignore case: `/a.txt` and `/A.txt` are one item. So every
// comparison of paths here is made on lowercased paths, a name taken "except for case" counts as taken, and a rename
// that only changes the case goes through a temporary name.

/** Where the server talks to Dropbox. Fixed here, never taken from a request or from config (spec §3.7). */
export type DropboxEndpoints = {
  authorization: string; token: string;
  /** RPC endpoints (`…/2`, JSON bodies) and content endpoints (`…/2`, arguments in `Dropbox-API-Arg`). */
  api: string; content: string;
};
export const DROPBOX_ENDPOINTS: DropboxEndpoints = {
  authorization: 'https://www.dropbox.com/oauth2/authorize',
  token: 'https://api.dropboxapi.com/oauth2/token',
  api: 'https://api.dropboxapi.com/2',
  content: 'https://content.dropboxapi.com/2',
};
/** What browsing, transfers and the account label need (DECISIONS #150); no sharing or team scopes. */
export const DROPBOX_SCOPES = ['account_info.read', 'files.metadata.read', 'files.content.read', 'files.content.write'] as const;
/** Bytes per upload-session request. One chunk is all an upload holds in memory; Dropbox takes up to 150 MiB. */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES = 150 * 1024 * 1024;
/** Entries per `list_folder` page when the caller names no limit; Dropbox takes 1 to 2000. */
const LIST_LIMIT = 500;
const MAX_LIST_LIMIT = 2000;
/** Dropbox's thumbnail sizes, smallest first; the first one whose longer side reaches the asked size is fetched. */
const THUMB_TAGS = [[128, 'w128h128'], [256, 'w256h256'], [640, 'w640h480'], [1024, 'w1024h768']] as const;

const File = z.object({ '.tag': z.literal('file'), name: z.string(), path_lower: z.string(), path_display: z.string(), id: z.string(),
  rev: z.string(), size: z.number().int().nonnegative(), server_modified: z.string(), content_hash: z.string().optional() });
const Folder = z.object({ '.tag': z.literal('folder'), name: z.string(), path_lower: z.string(), path_display: z.string(), id: z.string() });
// Results typed `FileMetadata`/`FolderMetadata` (not the `Metadata` union) carry no `.tag`: the download result header,
// upload_session/finish, list_revisions entries, restore and create_folder_v2. These schemas add it back.
const PlainFile = File.omit({ '.tag': true }).transform((m) => ({ '.tag': 'file' as const, ...m }));
const PlainFolder = Folder.omit({ '.tag': true }).transform((m) => ({ '.tag': 'folder' as const, ...m }));
const Deleted = z.object({ '.tag': z.literal('deleted'), name: z.string() });
const Metadata = z.discriminatedUnion('.tag', [File, Folder, Deleted]);
type Item = z.infer<typeof File> | z.infer<typeof Folder>;
const ListPage = z.object({ entries: z.array(Metadata), cursor: z.string(), has_more: z.boolean() });
// Search hits may lack both paths: Dropbox omits them for items outside the user's namespace (#205).
const unplaced = { path_lower: true, path_display: true } as const;
const SearchMetadata = z.discriminatedUnion('.tag', [File.partial(unplaced), Folder.partial(unplaced), Deleted]);
const DropboxError = z.object({ error_summary: z.string() });

/** Dropbox's root is the empty path. */
const dbxPath = (p: string) => (p === '/' ? '' : p);
const lower = (p: string) => p.toLowerCase();
const inside = (p: string, dir: string) => lower(p).startsWith(`${lower(dir)}/`);
const isFolder = (i: Item) => i['.tag'] === 'folder';
const live = (m: z.infer<typeof Metadata>): m is Item => m['.tag'] !== 'deleted';
const placed = (m: z.infer<typeof SearchMetadata>): m is Item =>
  m['.tag'] !== 'deleted' && m.path_lower !== undefined && m.path_display !== undefined;
const etagOf = (i: Item) => `"${i['.tag'] === 'file' ? i.rev : i.id}"`;
const fromWeb = (body: ReadableStream<Uint8Array>) => Readable.fromWeb(body as WebReadableStream<Uint8Array>);
const discard = async (res: Response) => { await res.body?.cancel(); };
/** `Dropbox-API-Arg` must be ASCII: everything else goes as a JSON `\u` escape, which Dropbox decodes. */
const apiArg = (v: unknown) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * Maps a Dropbox error answer to an error code. Dropbox answers 409 with an `error_summary` such as
 * `path/not_found/..`; anything unexpected is a plain Error (500, logged) with the status and that summary only.
 */
async function failure(res: Response, what: string, name?: string): Promise<never> {
  const text = await res.text();
  let summary: string;
  try { summary = DropboxError.parse(JSON.parse(text)).error_summary; }
  catch { summary = ''; } // handled: a body that is not Dropbox's JSON error leaves the status to decide
  if (res.status === 409) {
    if (/not_found/.test(summary)) throw new AppError('NOT_FOUND');
    if (/conflict/.test(summary)) throw new AppError('FILE_EXISTS', name !== undefined ? { name } : undefined);
    if (/insufficient_space/.test(summary)) throw new AppError('STORAGE_FULL');
    if (/not_folder/.test(summary)) throw new AppError('NOT_A_DIRECTORY');
    if (/not_file/.test(summary)) throw new AppError('IS_A_DIRECTORY');
    if (/malformed_path|disallowed_name/.test(summary)) throw new AppError('PATH_INVALID');
    if (/cant_move_folder_into_itself|duplicated_or_nested_paths/.test(summary)) throw new AppError('TARGET_INSIDE_SOURCE');
    if (/no_write_permission|restricted_content|team_folder|no_permission/.test(summary)) throw new AppError('FORBIDDEN');
    if (/too_many_write_operations/.test(summary)) throw new AppError('PROVIDER_UNAVAILABLE');
  }
  if (res.status === 403) throw new AppError('FORBIDDEN');
  throw new Error(`Dropbox ${what} answered ${res.status}${summary ? ` (${summary})` : ''}`);
}

/** The cursor handed to the client: Dropbox's, bound to the folder it lists, so it cannot continue another folder's listing. */
const Cursor = z.object({ p: z.string(), c: z.string().min(1) });
const wrapCursor = (folder: string, c: string) => Buffer.from(JSON.stringify({ p: lower(folder), c })).toString('base64url');
function unwrapCursor(folder: string, cursor: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { throw new AppError('VALIDATION'); } // handled: an unreadable cursor is the client's mistake
  const c = Cursor.safeParse(parsed);
  if (!c.success || c.data.p !== lower(folder)) throw new AppError('VALIDATION');
  return c.data.c;
}

export class DropboxBackend implements StorageBackend {
  constructor(private client: OAuthClient, private ep: DropboxEndpoints, private chunkBytes: number) {}

  // --- requests ---------------------------------------------------------------------------------------------------

  /** An RPC request (JSON in, JSON out); any answer but 2xx becomes an error. Redirects are never followed. */
  private async rpc(endpoint: string, arg: unknown, name?: string): Promise<unknown> {
    const res = await this.client.fetch(`${this.ep.api}/${endpoint}`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(arg) });
    if (!res.ok) await failure(res, endpoint, name);
    return res.json();
  }

  /** A content request: the argument goes in `Dropbox-API-Arg`. The answer is handed back as it is. */
  private content(endpoint: string, arg: unknown, o: { body?: Uint8Array; range?: ByteRange } = {}): Promise<Response> {
    const headers: Record<string, string> = { 'dropbox-api-arg': apiArg(arg) };
    if (o.body) headers['content-type'] = 'application/octet-stream';
    if (o.range) headers.range = `bytes=${o.range.start}-${o.range.end}`;
    return this.client.fetch(`${this.ep.content}/${endpoint}`, { method: 'POST', redirect: 'manual', headers,
      ...(o.body ? { body: o.body } : {}) });
  }

  private async meta(path: string): Promise<Item> {
    if (path === '/') return { '.tag': 'folder', name: 'Dropbox', path_lower: '', path_display: '', id: 'root' };
    const m = Metadata.parse(await this.rpc('files/get_metadata', { path }));
    if (!live(m)) throw new AppError('NOT_FOUND');
    return m;
  }
  private async metaOrNone(path: string): Promise<Item | undefined> {
    return this.meta(path).catch((e: unknown) => {
      if (e instanceof AppError && e.code === 'NOT_FOUND') return undefined; // handled: nothing is there
      throw e;
    });
  }

  /** Dropbox reports no time for a folder, so a folder's entry has none rather than a made-up one. */
  private entry(i: Item, path: string, name = i.name): Entry {
    if (i['.tag'] === 'folder') return { name, path, type: 'directory', size: 0 };
    // Dropbox's content hash, for the duplicate finder (#216).
    return withHash({ name, path, type: 'file', size: i.size, modified: new Date(i.server_modified).toISOString(), mime: lookupMime(name) },
      i.content_hash ? { algorithm: 'dropbox', value: i.content_hash } : undefined);
  }
  /** The entry of an item that now lives in `dir`, under Dropbox's name for it (which carries its case). */
  private placed(i: Item, dir: string): Entry { return this.entry(i, posix.join(dir, i.name)); }

  private async *pages(folder: string): AsyncGenerator<Item[]> {
    let page = ListPage.parse(await this.rpc('files/list_folder', { path: dbxPath(folder), limit: MAX_LIST_LIMIT }));
    for (;;) {
      yield page.entries.filter(live);
      if (!page.has_more) return;
      page = ListPage.parse(await this.rpc('files/list_folder/continue', { cursor: page.cursor }));
    }
  }

  /** `name (n).ext` with the lowest n that no item of the folder holds, ignoring case like Dropbox does. */
  private async freeName(dir: string, name: string): Promise<string> {
    const taken = new Set<string>();
    for await (const page of this.pages(dir)) for (const i of page) taken.add(lower(i.name));
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 1; ; n++) if (!taken.has(lower(`${stem} (${n})${ext}`))) return `${stem} (${n})${ext}`;
  }

  /** Into Dropbox's deleted files, from where the member can restore it at Dropbox. A permanent delete is never sent. */
  private async remove(path: string): Promise<void> {
    await this.rpc('files/delete_v2', { path });
  }

  // --- StorageBackend ---------------------------------------------------------------------------------------------

  /** One `list_folder` page per call; `next` carries Dropbox's cursor for `list_folder/continue`. */
  async list(path: string, cursor?: string, limit = LIST_LIMIT): Promise<{ entries: Entry[]; next?: string }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new AppError('VALIDATION');
    const dir = normalizeUserPath(path);
    const raw = cursor === undefined
      ? await this.rpc('files/list_folder', { path: dbxPath(dir), limit })
      : await this.rpc('files/list_folder/continue', { cursor: unwrapCursor(dir, cursor) });
    const page = ListPage.parse(raw);
    return { entries: page.entries.filter(live).map((i) => this.placed(i, dir)),
      ...(page.has_more ? { next: wrapCursor(dir, page.cursor) } : {}) };
  }

  async stat(path: string): Promise<Entry> {
    const p = normalizeUserPath(path);
    const i = await this.meta(p);
    return p === '/' ? this.entry(i, '/') : this.placed(i, posix.dirname(p));
  }

  async read(path: string, range?: ByteRange | ((size: number) => ByteRange | undefined)) {
    const p = normalizeUserPath(path);
    if (p === '/') throw new AppError('IS_A_DIRECTORY');
    // A range that depends on the size needs the size first.
    const r = typeof range === 'function' ? range((await this.fileMeta(p)).size) : range;
    const res = await this.content('files/download', { path: p }, r ? { range: r } : {});
    if (res.status === 416) { await discard(res); throw new RangeNotSatisfiable((await this.fileMeta(p)).size); }
    if (!res.ok || !res.body) await failure(res, 'download');
    if (res.status !== (r ? 206 : 200)) { await discard(res); throw new Error(`Dropbox download answered ${res.status} to ${r ? 'a' : 'no'} range`); }
    const parsed = PlainFile.safeParse(JSON.parse(res.headers.get('dropbox-api-result') ?? 'null'));
    if (!parsed.success) { await discard(res); throw new Error('Dropbox download answered without file metadata'); }
    const i = parsed.data;
    return { entry: this.placed(i, posix.dirname(p)), stream: fromWeb(res.body!), etag: etagOf(i), ...(r ? { range: r } : {}) };
  }
  private async fileMeta(p: string) {
    const i = await this.meta(p);
    if (i['.tag'] !== 'file') throw new AppError('IS_A_DIRECTORY');
    return i;
  }

  /**
   * An upload session: the body goes up in chunks of `chunkBytes`, one chunk in memory at a time, and the commit at the
   * end names the mode ("add", "overwrite" for replace, "update" with the revision for If-Match). A body longer or
   * shorter than declared never reaches the commit, so nothing is created; Dropbox drops the open session itself.
   */
  async write(path: string, body: Readable, opts: WriteOptions): Promise<Entry> {
    if (opts.ifMatch !== undefined && opts.onCollision !== 'replace') throw new AppError('VALIDATION');
    if (opts.size !== undefined && opts.size > opts.maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');
    const p = normalizeUserPath(path);
    if (p === '/') throw new AppError('PATH_INVALID');
    const dir = posix.dirname(p);
    let target = p;
    const existing = await this.metaOrNone(p);
    let mode: unknown = 'add';
    if (opts.ifMatch !== undefined) {
      if (existing?.['.tag'] !== 'file' || etagOf(existing) !== opts.ifMatch) throw new AppError('PRECONDITION_FAILED');
      mode = { '.tag': 'update', update: existing.rev };
    } else if (existing) {
      if (opts.onCollision === 'fail') throw new AppError('FILE_EXISTS', { name: posix.basename(p) });
      if (opts.onCollision === 'keep-both') target = posix.join(dir, await this.freeName(dir, posix.basename(p)));
      else if (isFolder(existing)) await this.remove(existing.path_display); // a file takes the folder's place
      else mode = 'overwrite'; // Dropbox keeps the old content as a revision
    }

    let session: string | undefined;
    let sent = 0;
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(this.chunkBytes, opts.size ?? this.chunkBytes)));
    let fill = 0;
    const send = async (chunk: Buffer) => {
      if (session === undefined) {
        const res = await this.content('files/upload_session/start', { close: false }, { body: chunk });
        if (!res.ok) await failure(res, 'upload session');
        session = z.object({ session_id: z.string().min(1) }).parse(await res.json()).session_id;
      } else {
        const res = await this.content('files/upload_session/append_v2', { cursor: { session_id: session, offset: sent }, close: false }, { body: chunk });
        if (!res.ok) await failure(res, 'upload');
        await discard(res);
      }
      sent += chunk.length;
    };
    for await (const c of body) {
      let data = c as Buffer;
      const total = sent + fill + data.length;
      if (opts.size !== undefined && total > opts.size) throw new AppError('SIZE_MISMATCH');
      if (total > opts.maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');
      while (data.length > 0) {
        const take = Math.min(buf.length - fill, data.length);
        data.copy(buf, fill, 0, take);
        fill += take; data = data.subarray(take);
        if (fill === buf.length) { await send(buf); fill = 0; }
      }
    }
    if (opts.size !== undefined && sent + fill !== opts.size) throw new AppError('SIZE_MISMATCH');
    if (session === undefined) { await send(buf.subarray(0, fill)); fill = 0; }
    const res = await this.content('files/upload_session/finish', {
      cursor: { session_id: session, offset: sent },
      commit: { path: target, mode, autorename: false, mute: true },
    }, { body: buf.subarray(0, fill) });
    if (!res.ok) {
      await failure(res, 'upload commit', posix.basename(target)).catch((e: unknown) => {
        // Under If-Match a conflict means the revision changed meanwhile.
        if (opts.ifMatch !== undefined && e instanceof AppError && e.code === 'FILE_EXISTS') throw new AppError('PRECONDITION_FAILED');
        throw e;
      });
    }
    return this.placed(PlainFile.parse(await res.json()), dir);
  }

  async mkdir(path: string): Promise<Entry> {
    const p = normalizeUserPath(path);
    const name = posix.basename(p);
    if (p === '/') throw new AppError('FILE_EXISTS', { name: '/' });
    const r = z.object({ metadata: PlainFolder }).parse(await this.rpc('files/create_folder_v2', { path: p, autorename: false }, name));
    return this.placed(r.metadata, posix.dirname(p));
  }

  async move(from: string, to: string, onCollision: CollisionPolicy): Promise<Entry> {
    const f = normalizeUserPath(from); let t = normalizeUserPath(to);
    if (f === t) return this.stat(f);
    if (f === '/' || t === '/') throw new AppError('PATH_INVALID');
    if (inside(t, f)) throw new AppError('TARGET_INSIDE_SOURCE');
    const item = await this.meta(f);
    if (lower(f) === lower(t)) return this.renameCase(item, t);
    const existing = await this.metaOrNone(t);
    if (existing) {
      if (onCollision === 'fail') throw new AppError('FILE_EXISTS', { name: posix.basename(t) });
      if (onCollision === 'keep-both') t = posix.join(posix.dirname(t), await this.freeName(posix.dirname(t), posix.basename(t)));
      else {
        if (inside(f, t)) throw new AppError('TARGET_INSIDE_SOURCE');
        await this.remove(existing.path_display);
      }
    }
    return this.placed(await this.transfer('files/move_v2', item.path_display, t), posix.dirname(t));
  }

  /**
   * A rename that only changes the case (`a.txt` → `A.txt`): to Dropbox both paths are the same item, so the item in
   * the way is the item itself. It moves to a free temporary name and from there to the new one; if the second step
   * fails, it goes back.
   */
  private async renameCase(item: Item, t: string): Promise<Entry> {
    const dir = posix.dirname(t);
    const tmp = posix.join(dir, `.files-rename-${randomBytes(6).toString('hex')}`);
    await this.transfer('files/move_v2', item.path_display, tmp);
    try {
      return this.placed(await this.transfer('files/move_v2', tmp, t), dir);
    } catch (err) {
      try { await this.transfer('files/move_v2', tmp, item.path_display); }
      catch (undo) { throw new AggregateError([err, undo], 'Dropbox rename failed and could not be undone', { cause: undo }); }
      throw err;
    }
  }

  private async transfer(endpoint: 'files/move_v2' | 'files/copy_v2', from: string, to: string): Promise<Item> {
    const r = await this.rpc(endpoint, { from_path: from, to_path: to, autorename: false }, posix.basename(to));
    const m = z.object({ metadata: Metadata }).parse(r).metadata;
    if (!live(m)) throw new Error(`Dropbox ${endpoint} answered a deleted item`);
    return m;
  }

  async copy(from: string, to: string, onCollision: CollisionPolicy): Promise<Entry> {
    const f = normalizeUserPath(from); let t = normalizeUserPath(to);
    if (f === '/' || t === '/') throw new AppError('PATH_INVALID');
    if (inside(t, f)) throw new AppError('TARGET_INSIDE_SOURCE');
    const item = await this.meta(f);
    // Onto its own name (in any case): "fail" asks, "replace" leaves it as it is, "keep both" duplicates.
    const same = lower(f) === lower(t);
    const existing = same ? item : await this.metaOrNone(t);
    if (existing) {
      if (onCollision === 'fail') throw new AppError('FILE_EXISTS', { name: posix.basename(t) });
      if (onCollision === 'replace' && same) return this.stat(f);
      if (onCollision === 'keep-both') t = posix.join(posix.dirname(t), await this.freeName(posix.dirname(t), posix.basename(t)));
      else {
        if (inside(f, t)) throw new AppError('TARGET_INSIDE_SOURCE');
        await this.remove(existing.path_display);
      }
    }
    // Dropbox copies on its side: no bytes pass the shard.
    return this.placed(await this.transfer('files/copy_v2', item.path_display, t), posix.dirname(t));
  }

  /**
   * Every path is looked up before anything is deleted, so a missing one changes nothing. A path beneath another one
   * (in any case) goes with it. Dropbox has no transaction: if a delete fails halfway, the items before it are already
   * in Dropbox's deleted files (DECISIONS #150).
   */
  async delete(paths: readonly string[]): Promise<void> {
    const all = paths.map(normalizeUserPath);
    if (all.includes('/')) throw new AppError('PATH_INVALID');
    const seen = new Set<string>();
    const top = all.filter((p) => !all.some((o) => inside(p, o)) && !seen.has(lower(p)) && seen.add(lower(p)));
    const items: Item[] = [];
    for (const p of top) items.push(await this.meta(p));
    for (const i of items) await this.remove(i.path_display);
  }

  async quota(): Promise<{ used: number; total?: number }> {
    const r = z.object({ used: z.number(), allocation: z.object({ allocated: z.number().optional() }) })
      .parse(await this.rpc('users/get_space_usage', null));
    return { used: r.used, ...(r.allocation.allocated !== undefined ? { total: r.allocation.allocated } : {}) };
  }

  /** Dropbox keeps the last 100 revisions it lists here; it answers newest first. */
  async revisions(path: string): Promise<Revision[]> {
    const p = normalizeUserPath(path);
    if (p === '/') throw new AppError('IS_A_DIRECTORY');
    const r = z.object({ entries: z.array(PlainFile) }).parse(await this.rpc('files/list_revisions', { path: p, mode: 'path', limit: 100 }));
    // The newest is the file as it is now.
    return r.entries.map((e, i) => ({ id: e.rev, modified: new Date(e.server_modified).toISOString(), size: e.size, ...(i === 0 ? { current: true } : {}) }))
      .reverse();
  }

  /** Dropbox's own `files/restore` (#154): the revision becomes the newest one; the content it replaces stays a revision. */
  async restoreRevision(path: string, id: string): Promise<Entry> {
    const p = normalizeUserPath(path);
    if (p === '/') throw new AppError('IS_A_DIRECTORY');
    const m = PlainFile.parse(await this.rpc('files/restore', { path: p, rev: id }));
    return this.entry(m, p);
  }

  /** Dropbox's own thumbnail, fetched by the server and re-encoded as WebP; null where Dropbox has none for the type. */
  async thumbnail(path: string, size: ThumbSize): Promise<Readable | null> {
    const p = normalizeUserPath(path);
    if (p === '/') return null;
    const tag = THUMB_TAGS.find(([edge]) => edge >= size)![1];
    const res = await this.content('files/get_thumbnail_v2', { resource: { '.tag': 'path', path: p }, format: { '.tag': 'png' },
      size: { '.tag': tag }, mode: { '.tag': 'fitone_bestfit' } });
    if (res.status === 409) {
      const text = await res.text();
      if (/unsupported_extension|unsupported_image|unsupported_content/.test(text)) return null;
      return failure(new Response(text, { status: 409 }), 'thumbnail');
    }
    if (!res.ok || !res.body) await failure(res, 'thumbnail');
    const out = sharp().rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp();
    const input = fromWeb(res.body!);
    input.on('error', (e) => out.destroy(e));
    return input.pipe(out);
  }

  /**
   * Dropbox's `search_v2` matches words; its results are narrowed to names that contain the query anywhere, ignoring
   * case, like the home's search. Paths are Dropbox's `path_display`. A hit outside the user's namespace (an unmounted
   * shared folder) has no path and cannot be opened, so it is skipped (#205).
   */
  async search(query: string, limit: number): Promise<Entry[]> {
    const needle = query.normalize('NFC').toLowerCase();
    const Page = z.object({ matches: z.array(z.object({ metadata: z.object({ metadata: SearchMetadata }) })), has_more: z.boolean(),
      cursor: z.string().optional() });
    const out: Entry[] = [];
    let page = Page.parse(await this.rpc('files/search_v2', { query,
      options: { path: '', max_results: Math.min(1000, Math.max(limit, 1)), file_status: 'active', filename_only: true } }));
    for (;;) {
      for (const { metadata: { metadata: m } } of page.matches) {
        if (!placed(m) || !m.name.normalize('NFC').toLowerCase().includes(needle)) continue;
        out.push(this.entry(m, m.path_display));
        if (out.length >= limit) return out;
      }
      if (!page.has_more || page.cursor === undefined) return out;
      page = Page.parse(await this.rpc('files/search/continue_v2', { cursor: page.cursor }));
    }
  }
}

/**
 * The Dropbox provider. Endpoints are Dropbox's unless code (the tests' fake Dropbox) passes others; the app key and
 * secret come from config (`FILES_DROPBOX_CLIENT_ID`/`_SECRET`). `token_access_type=offline` makes Dropbox issue a
 * refresh token; its access tokens are short-lived (four hours) and renewed by the OAuthClient.
 */
export function dropboxProvider(creds: { clientId: string; clientSecret: string },
  o: { endpoints?: DropboxEndpoints; chunkBytes?: number } = {}): Provider {
  const ep = o.endpoints ?? DROPBOX_ENDPOINTS;
  const chunk = o.chunkBytes ?? UPLOAD_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunk) || chunk <= 0 || chunk > MAX_CHUNK_BYTES) throw new Error('chunkBytes must be between 1 byte and 150 MiB');
  return {
    id: 'dropbox', name: 'Dropbox', authorizationEndpoint: ep.authorization, tokenEndpoint: ep.token,
    clientId: creds.clientId, clientSecret: creds.clientSecret, scopes: DROPBOX_SCOPES, pkce: true,
    authorizationParams: { token_access_type: 'offline' },
    async account(client) {
      const res = await client.fetch(`${ep.api}/users/get_current_account`, { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json' }, body: 'null' });
      if (!res.ok) await failure(res, 'get_current_account');
      const me = z.object({ account_id: z.string().min(1), email: z.string().optional() }).parse(await res.json());
      return { id: me.account_id, label: me.email ?? me.account_id };
    },
    backend: (client) => new DropboxBackend(client, ep, chunk),
  };
}
