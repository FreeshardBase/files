import { posix } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import sharp from 'sharp';
import { z } from 'zod';
import type { CollisionPolicy, Entry, ThumbSize } from '@files/shared';
import { AppError } from '../errors.ts';
import { RangeNotSatisfiable, type ByteRange, type Revision, type StorageBackend, type WriteOptions } from '../storage/backend.ts';
import { lookupMime } from '../storage/mime.ts';
import { normalizeUserPath } from '../storage/resolveInRoot.ts';
import type { OAuthClient, Provider } from './oauth.ts';

// pCloud (#211): a `StorageBackend` over pCloud's HTTP JSON API, live, through the connection's OAuthClient (bearer
// token, backoff on 429/5xx). pCloud keeps an account in one region, and its API host follows: `api.pcloud.com` (US) or
// `eapi.pcloud.com` (EU). The consent names it (`hostname`), and only those two hosts are ever called. The access token
// never expires and comes without a refresh token, so the connection keeps it, with its host, as its credential.
// pCloud answers almost every failure, a refused token included, with HTTP 200 and a `result` code in the JSON.

/** Where the server talks to pCloud. Fixed here, never taken from a request or from config (spec §3.7). */
export type PcloudEndpoints = {
  /** The consent page (`my.pcloud.com`, the same for both regions). */
  authorization: string;
  /** The base URL of each API host pCloud may name: the allowlist, by hostname. */
  api: ReadonlyMap<string, string>;
  /** The URL of a download link on a content host `getfilelink` named, or undefined for a host off the allowlist. */
  content(host: string, path: string): string | undefined;
};
/** pCloud's content hosts (`c123.pcloud.com`, `p-def1.pcloud.com`, …): one label under pcloud.com, https only. */
const CONTENT_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.pcloud\.com$/;
export const PCLOUD_ENDPOINTS: PcloudEndpoints = {
  authorization: 'https://my.pcloud.com/oauth2/authorize',
  api: new Map([['api.pcloud.com', 'https://api.pcloud.com'], ['eapi.pcloud.com', 'https://eapi.pcloud.com']]),
  content: (host, path) => {
    if (!CONTENT_HOST.test(host) || !path.startsWith('/')) return undefined;
    const u = new URL(path, `https://${host}/`);
    return u.host === host && u.protocol === 'https:' ? u.href : undefined;
  },
};
/** Bytes per `upload_write`. One chunk is all an upload holds in memory. */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES = 1024 * 1024 * 1024;
const TOKEN_TIMEOUT_MS = 30_000;

/** The connection's credential: pCloud's access token and the API host of its region. */
const Credential = z.object({ host: z.string(), token: z.string().min(1) });
export const pcloudCredential = (host: string, token: string) => JSON.stringify({ host, token });
const readCredential = (credential: string) => Credential.parse(JSON.parse(credential));

const Item = z.object({
  name: z.string(), isfolder: z.boolean(), modified: z.string().optional(),
  fileid: z.number().optional(), folderid: z.number().optional(), size: z.number().int().nonnegative().optional(),
  // pCloud's 64-bit content hash, kept as its digits (see `parse`).
  hash: z.string().optional(), thumb: z.boolean().optional(),
});
type Item = z.infer<typeof Item>;
const Folder = Item.extend({ contents: z.array(Item).optional() });
const Answer = z.object({ result: z.number().int() }).passthrough();
const Link = z.object({ path: z.string(), hosts: z.array(z.string()) });
const RevisionList = z.object({ revisions: z.array(z.object({ revisionid: z.number().int(), size: z.number().int().nonnegative(),
  created: z.string() })), metadata: Item });

/** pCloud's `result` codes for a token it no longer accepts: the member has to sign in again. */
const REFUSED = new Set([1000, 2000, 2094, 2095]);
/** pCloud's `result` codes the app has an answer for (docs.pcloud.com, the "Errors" of each method). */
const CODES: Readonly<Record<number, 'NOT_FOUND' | 'FILE_EXISTS' | 'PATH_INVALID' | 'FORBIDDEN' | 'STORAGE_FULL' | 'TARGET_INSIDE_SOURCE'
  | 'PROVIDER_UNAVAILABLE'>> = {
  2001: 'PATH_INVALID', 2002: 'NOT_FOUND', 2003: 'FORBIDDEN', 2004: 'FILE_EXISTS', 2005: 'NOT_FOUND', 2008: 'STORAGE_FULL',
  2009: 'NOT_FOUND', 2010: 'PATH_INVALID', 2043: 'TARGET_INSIDE_SOURCE', 4000: 'PROVIDER_UNAVAILABLE', 5000: 'PROVIDER_UNAVAILABLE',
};

/** JSON with every `hash` kept as its digits: pCloud's is a 64-bit number, beyond what a JavaScript number holds. */
const parse = (text: string): unknown => JSON.parse(text, (key, value: unknown, ctx?: { source?: string }) =>
  (key === 'hash' && typeof value === 'number' && ctx?.source !== undefined ? ctx.source : value));
const fromWeb = (body: ReadableStream<Uint8Array>) => Readable.fromWeb(body as WebReadableStream<Uint8Array>);
const discard = async (res: Response) => { await res.body?.cancel(); };
const inside = (p: string, dir: string) => p.startsWith(`${dir}/`);
const iso = (rfc: string | undefined) => (rfc === undefined ? undefined : new Date(rfc).toISOString());
const etagOf = (i: Item) => `"${i.fileid}-${i.hash}"`;
const strings = (params: Record<string, string | number>) => Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));

export class PcloudBackend implements StorageBackend {
  constructor(private client: OAuthClient, private ep: PcloudEndpoints, private chunkBytes: number) {}

  // --- requests ---------------------------------------------------------------------------------------------------

  /** The connection's API host, checked against the allowlist on every request (the credential comes from the db). */
  private base(): string {
    const base = this.ep.api.get(readCredential(this.client.credential()).host);
    if (base === undefined) throw new Error('pCloud connection names an API host outside the allowlist');
    return base;
  }

  /** A method call; the parameters go in a form body. Any answer but `result: 0` becomes an error. */
  private async call(method: string, params: Record<string, string | number>, name?: string): Promise<Record<string, unknown>> {
    const res = await this.client.fetch(`${this.base()}/${method}`, { method: 'POST', redirect: 'manual',
      body: new URLSearchParams(strings(params)) });
    return this.answer(res, method, name);
  }

  private async answer(res: Response, method: string, name?: string): Promise<Record<string, unknown>> {
    if (!res.ok) { await discard(res); throw new Error(`pCloud ${method} answered ${res.status}`); }
    const body = Answer.parse(parse(await res.text()));
    if (body.result !== 0) this.failure(body.result, method, name);
    return body;
  }

  /** Maps a `result` code to an error code; anything unexpected is a plain Error (500, logged) with the code only. */
  private failure(result: number, method: string, name?: string): never {
    if (REFUSED.has(result)) this.client.refused();
    const code = CODES[result];
    if (code === 'FILE_EXISTS') throw new AppError(code, name !== undefined ? { name } : undefined);
    if (code !== undefined) throw new AppError(code);
    throw new Error(`pCloud ${method} answered result ${result}`);
  }

  /**
   * The item at `path`. `stat` answers for files; a folder is looked up with `listfolder` (without its files) when
   * `stat` finds no file there.
   */
  private async meta(path: string): Promise<Item> {
    if (path === '/') return { name: 'pCloud', isfolder: true, folderid: 0 };
    try {
      return Item.parse((await this.call('stat', { path })).metadata);
    } catch (err) { // handled: no file there, so a folder is looked for; anything else is rethrown
      if (!(err instanceof AppError && err.code === 'NOT_FOUND')) throw err;
      return Folder.parse((await this.call('listfolder', { path, nofiles: 1 })).metadata);
    }
  }

  /** The account behind the token (`userinfo`): pCloud's user id and the e-mail address. */
  async account(): Promise<{ id: string; label: string }> {
    const r = z.object({ userid: z.number().int(), email: z.string().optional() }).parse(await this.call('userinfo', {}));
    return { id: String(r.userid), label: r.email ?? String(r.userid) };
  }
  private async metaOrNone(path: string): Promise<Item | undefined> {
    return this.meta(path).catch((e: unknown) => {
      if (e instanceof AppError && e.code === 'NOT_FOUND') return undefined; // handled: nothing is there
      throw e;
    });
  }
  private async fileMeta(path: string): Promise<Item> {
    const i = await this.meta(path);
    if (i.isfolder) throw new AppError('IS_A_DIRECTORY');
    return i;
  }

  private entry(i: Item, path: string): Entry {
    const name = path === '/' ? '/' : posix.basename(path);
    const modified = iso(i.modified);
    if (i.isfolder) return { name, path, type: 'directory', size: 0, ...(modified ? { modified } : {}) };
    return { name, path, type: 'file', size: i.size ?? 0, ...(modified ? { modified } : {}), mime: lookupMime(name) };
  }

  /** `name (n).ext` with the lowest n that no item of the folder holds. */
  private async freeName(dir: string, name: string): Promise<string> {
    const r = Folder.parse((await this.call('listfolder', { path: dir })).metadata);
    const taken = new Set((r.contents ?? []).map((i) => i.name));
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 1; ; n++) if (!taken.has(`${stem} (${n})${ext}`)) return `${stem} (${n})${ext}`;
  }

  /** Into pCloud's trash, from where the member can restore it at pCloud. */
  private async remove(i: Item, path: string): Promise<void> {
    await this.call(i.isfolder ? 'deletefolderrecursive' : 'deletefile', { path });
  }

  // --- StorageBackend ---------------------------------------------------------------------------------------------

  /** pCloud lists a folder whole (`listfolder` has no paging), so no cursor is ever handed out. */
  async list(path: string, cursor?: string): Promise<{ entries: Entry[]; next?: string }> {
    if (cursor !== undefined) throw new AppError('VALIDATION');
    const dir = normalizeUserPath(path);
    let r;
    try {
      r = Folder.parse((await this.call('listfolder', { path: dir })).metadata);
    } catch (err) { // handled: pCloud says "Directory does not exist" for a file too, which is NOT_A_DIRECTORY; else rethrown
      if (err instanceof AppError && err.code === 'NOT_FOUND' && (await this.metaOrNone(dir))?.isfolder === false) throw new AppError('NOT_A_DIRECTORY');
      throw err;
    }
    return { entries: (r.contents ?? []).map((i) => this.entry(i, posix.join(dir, i.name))) };
  }

  async stat(path: string): Promise<Entry> {
    const p = normalizeUserPath(path);
    return this.entry(await this.meta(p), p);
  }

  /**
   * `getfilelink` names content hosts and a path; the bytes stream from the first host on the allowlist, without the
   * token (the link is the capability), with the Range passed on.
   */
  async read(path: string, range?: ByteRange | ((size: number) => ByteRange | undefined)) {
    const p = normalizeUserPath(path);
    if (p === '/') throw new AppError('IS_A_DIRECTORY');
    const i = await this.fileMeta(p);
    const size = i.size ?? 0;
    const r = typeof range === 'function' ? range(size) : range;
    const link = Link.parse(await this.call('getfilelink', { path: p }));
    const url = link.hosts.map((h) => this.ep.content(h, link.path)).find((u) => u !== undefined);
    if (url === undefined) throw new Error('pCloud named no content host on the allowlist');
    const res = await fetch(url, { redirect: 'manual', ...(r ? { headers: { range: `bytes=${r.start}-${r.end}` } } : {}) });
    if (res.status === 416) { await discard(res); throw new RangeNotSatisfiable(size); }
    if (res.status !== (r ? 206 : 200) || !res.body) {
      await discard(res);
      throw new Error(`pCloud content host answered ${res.status} to ${r ? 'a' : 'no'} range`);
    }
    return { entry: this.entry(i, p), stream: fromWeb(res.body), etag: etagOf(i), ...(r ? { range: r } : {}) };
  }

  /**
   * An upload: `upload_create`, the body in `upload_write`s of `chunkBytes` (one chunk in memory at a time), then
   * `upload_save` into the folder, which gives an existing file a new revision. A body longer or shorter than declared
   * is never saved, and the upload is deleted. pCloud has no conditional save: If-Match is checked just before the
   * upload starts.
   */
  async write(path: string, body: Readable, opts: WriteOptions): Promise<Entry> {
    if (opts.ifMatch !== undefined && opts.onCollision !== 'replace') throw new AppError('VALIDATION');
    if (opts.size !== undefined && opts.size > opts.maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');
    const p = normalizeUserPath(path);
    if (p === '/') throw new AppError('PATH_INVALID');
    const dir = posix.dirname(p);
    let name = posix.basename(p);
    const existing = await this.metaOrNone(p);
    if (opts.ifMatch !== undefined) {
      if (!existing || existing.isfolder || etagOf(existing) !== opts.ifMatch) throw new AppError('PRECONDITION_FAILED');
    } else if (existing) {
      if (opts.onCollision === 'fail') throw new AppError('FILE_EXISTS', { name });
      if (opts.onCollision === 'keep-both') name = await this.freeName(dir, name);
      else if (existing.isfolder) await this.remove(existing, p); // a file takes the folder's place
    }

    const upload = z.object({ uploadid: z.number().int() }).parse(await this.call('upload_create', {})).uploadid;
    try {
      let sent = 0;
      const buf = Buffer.allocUnsafe(Math.max(1, Math.min(this.chunkBytes, opts.size ?? this.chunkBytes)));
      let fill = 0;
      const send = async (chunk: Buffer) => {
        const q = new URLSearchParams({ uploadid: String(upload), uploadoffset: String(sent) });
        const res = await this.client.fetch(`${this.base()}/upload_write?${q}`, { method: 'PUT', redirect: 'manual',
          headers: { 'content-type': 'application/octet-stream' }, body: chunk });
        await this.answer(res, 'upload_write');
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
      if (fill > 0) await send(buf.subarray(0, fill));
      const saved = await this.call('upload_save', { uploadid: upload, path: dir, name }, name);
      return this.entry(Item.parse(saved.metadata), posix.join(dir, name));
    } catch (err) {
      // An upload that is not saved is deleted; if that fails too, both errors are told.
      try { await this.call('upload_delete', { uploadid: upload }); }
      catch (undo) { throw new AggregateError([err, undo], 'pCloud upload failed and could not be deleted', { cause: undo }); }
      throw err;
    }
  }

  async mkdir(path: string): Promise<Entry> {
    const p = normalizeUserPath(path);
    if (p === '/') throw new AppError('FILE_EXISTS', { name: '/' });
    return this.entry(Item.parse((await this.call('createfolder', { path: p }, posix.basename(p))).metadata), p);
  }

  /** Clears the way at `t` as `onCollision` asks; answers the target path to use. */
  private async clear(f: string, t: string, onCollision: CollisionPolicy): Promise<string> {
    const existing = await this.metaOrNone(t);
    if (!existing) return t;
    if (onCollision === 'fail') throw new AppError('FILE_EXISTS', { name: posix.basename(t) });
    if (onCollision === 'keep-both') return posix.join(posix.dirname(t), await this.freeName(posix.dirname(t), posix.basename(t)));
    if (inside(f, t)) throw new AppError('TARGET_INSIDE_SOURCE');
    await this.remove(existing, t);
    return t;
  }

  async move(from: string, to: string, onCollision: CollisionPolicy): Promise<Entry> {
    const f = normalizeUserPath(from); let t = normalizeUserPath(to);
    if (f === t) return this.stat(f);
    if (f === '/' || t === '/') throw new AppError('PATH_INVALID');
    if (inside(t, f)) throw new AppError('TARGET_INSIDE_SOURCE');
    const item = await this.meta(f);
    t = await this.clear(f, t, onCollision);
    const m = await this.call(item.isfolder ? 'renamefolder' : 'renamefile', { path: f, topath: t }, posix.basename(t));
    return this.entry(Item.parse(m.metadata), t);
  }

  /**
   * pCloud copies on its side: no bytes pass the shard. A folder is created under its new name first and gets the
   * source's contents (`copyfolder` with `copycontentonly`); if that fails, the new folder goes again.
   */
  async copy(from: string, to: string, onCollision: CollisionPolicy): Promise<Entry> {
    const f = normalizeUserPath(from); let t = normalizeUserPath(to);
    if (f === '/' || t === '/') throw new AppError('PATH_INVALID');
    if (inside(t, f)) throw new AppError('TARGET_INSIDE_SOURCE');
    const item = await this.meta(f);
    // Onto itself under "replace" it stays as it is; "fail" asks and "keep both" duplicates, as for any taken name.
    if (f === t && onCollision === 'replace') return this.entry(item, f);
    t = await this.clear(f, t, onCollision);
    if (!item.isfolder) {
      return this.entry(Item.parse((await this.call('copyfile', { path: f, topath: t, noover: 1 }, posix.basename(t))).metadata), t);
    }
    const made = Item.parse((await this.call('createfolder', { path: t }, posix.basename(t))).metadata);
    try {
      await this.call('copyfolder', { path: f, tofolderid: made.folderid!, copycontentonly: 1, noover: 1 });
    } catch (err) {
      try { await this.remove(made, t); }
      catch (undo) { throw new AggregateError([err, undo], 'pCloud folder copy failed and could not be undone', { cause: undo }); }
      throw err;
    }
    return this.entry(made, t);
  }

  /**
   * Every path is looked up before anything is deleted, so a missing one changes nothing. A path beneath another one
   * goes with it. pCloud has no transaction: if a delete fails halfway, the items before it are already in the trash.
   */
  async delete(paths: readonly string[]): Promise<void> {
    const all = paths.map(normalizeUserPath);
    if (all.includes('/')) throw new AppError('PATH_INVALID');
    const top = [...new Set(all)].filter((p) => !all.some((o) => inside(p, o)));
    const items: [Item, string][] = [];
    for (const p of top) items.push([await this.meta(p), p]);
    for (const [i, p] of items) await this.remove(i, p);
  }

  async quota(): Promise<{ used: number; total?: number }> {
    const r = z.object({ usedquota: z.number(), quota: z.number().optional() }).parse(await this.call('userinfo', {}));
    return { used: r.usedquota, ...(r.quota !== undefined ? { total: r.quota } : {}) };
  }

  /** pCloud's earlier contents of the file, oldest first; the file as it is now comes last (`current`). */
  async revisions(path: string): Promise<Revision[]> {
    const p = normalizeUserPath(path);
    if (p === '/') throw new AppError('IS_A_DIRECTORY');
    const r = RevisionList.parse(await this.call('listrevisions', { path: p }));
    const older = r.revisions.map((x) => ({ id: String(x.revisionid), modified: new Date(x.created).toISOString(), size: x.size }))
      .sort((x, y) => x.modified.localeCompare(y.modified));
    return [...older, { id: 'current', modified: iso(r.metadata.modified) ?? new Date(0).toISOString(), size: r.metadata.size ?? 0, current: true }];
  }

  /** pCloud's own `revertrevision`: the revision becomes the content; the content it replaces stays a revision. */
  async restoreRevision(path: string, id: string): Promise<Entry> {
    const p = normalizeUserPath(path);
    if (p === '/') throw new AppError('IS_A_DIRECTORY');
    if (!/^\d{1,18}$/.test(id)) throw new AppError('VALIDATION');
    return this.entry(Item.parse((await this.call('revertrevision', { path: p, revisionid: id })).metadata), p);
  }

  /** pCloud's own thumbnail (`getthumb`), re-encoded as WebP; null where pCloud has none for the file (`thumb`). */
  async thumbnail(path: string, size: ThumbSize): Promise<Readable | null> {
    const p = normalizeUserPath(path);
    if (p === '/') return null;
    const i = await this.meta(p);
    if (i.isfolder || i.thumb !== true) return null;
    const res = await this.client.fetch(`${this.base()}/getthumb`, { method: 'POST', redirect: 'manual',
      body: new URLSearchParams({ path: p, size: `${size}x${size}`, type: 'png' }) });
    // An image, or pCloud's JSON with the `result` code.
    if (!res.ok || !res.body || /json/.test(res.headers.get('content-type') ?? '')) {
      await this.answer(res, 'getthumb');
      throw new Error('pCloud getthumb answered no image');
    }
    const out = sharp().rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp();
    const input = fromWeb(res.body);
    input.on('error', (e) => out.destroy(e));
    return input.pipe(out);
  }
}

/**
 * Trades the code at the API host the callback names, after checking it against the allowlist. The token never
 * expires; with its host it becomes the connection's credential.
 */
async function exchange(ep: PcloudEndpoints, creds: { clientId: string; clientSecret: string }, code: string, hostname: string | undefined) {
  const base = hostname === undefined ? undefined : ep.api.get(hostname);
  if (base === undefined) throw new Error('pCloud callback names no allowed API host');
  const res = await fetch(`${base}/oauth2_token`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, code }) });
  // The body may echo the grant; only the status or the result code is ever put into an error (and so into a log).
  if (!res.ok) { await discard(res); throw new Error(`pCloud oauth2_token answered ${res.status}`); }
  const r = z.object({ result: z.number().int(), access_token: z.string().min(1).optional() }).parse(parse(await res.text()));
  if (r.result !== 0 || r.access_token === undefined) throw new Error(`pCloud oauth2_token answered result ${r.result}`);
  return pcloudCredential(hostname!, r.access_token);
}

/**
 * The pCloud provider. Endpoints are pCloud's unless code (the tests' fake pCloud) passes others; the client id and
 * secret come from config (`FILES_PCLOUD_CLIENT_ID`/`_SECRET`). pCloud takes no scopes and no PKCE.
 */
export function pcloudProvider(creds: { clientId: string; clientSecret: string },
  o: { endpoints?: PcloudEndpoints; chunkBytes?: number } = {}): Provider {
  const ep = o.endpoints ?? PCLOUD_ENDPOINTS;
  const chunk = o.chunkBytes ?? UPLOAD_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunk) || chunk <= 0 || chunk > MAX_CHUNK_BYTES) throw new Error('chunkBytes must be between 1 byte and 1 GiB');
  return {
    id: 'pcloud', name: 'pCloud', authorizationEndpoint: ep.authorization,
    // Unused: the code goes to the region's host (`longLived.exchange`).
    tokenEndpoint: `${ep.api.get('api.pcloud.com')}/oauth2_token`,
    clientId: creds.clientId, clientSecret: creds.clientSecret, scopes: [], pkce: false,
    longLived: {
      exchange: (_clock, p) => exchange(ep, creds, p.code, p.callback.hostname),
      bearer: (credential) => readCredential(credential).token,
    },
    account: (client) => new PcloudBackend(client, ep, chunk).account(),
    backend: (client) => new PcloudBackend(client, ep, chunk),
  };
}
