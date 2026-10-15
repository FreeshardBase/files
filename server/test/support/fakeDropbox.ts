import type http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { FakeRequest } from './fakeProvider.ts';
import { generatedByte } from './fakeDrive.ts';

// The Dropbox API v2 subset that DropboxBackend uses (#150), mounted on the fake provider (spec §3.9) under
// `/dropbox/api/2/…` (RPC, JSON bodies) and `/dropbox/content/2/…` (content, arguments in `Dropbox-API-Arg`, which must
// be ASCII as at Dropbox). Paths are case-insensitive: an item is found by its lowercased path and keeps the case it
// was created with. `list_folder` pages through `list_folder/continue`, downloads honour Range, uploads go through
// upload sessions (start, append_v2, finish with the commit mode), deletes go to Dropbox's deleted files, and a move
// whose paths differ only in case is refused, so the backend has to handle it explicitly. Bearer tokens, injected
// failures and 401s are handled by the fake provider before a request gets here.

/** Uploads above this are counted and hashed, not kept: the 1 GB test must not fill the fake's memory either. */
const KEEP_UPLOAD_BYTES = 16 * 1024 * 1024;
const BLOCK = Buffer.from(Array.from({ length: 65536 }, (_, i) => generatedByte(i)));

type Content = { kind: 'bytes'; data: Buffer } | { kind: 'generated'; size: number } | { kind: 'counted'; size: number; md5: string };
export type DropboxItem = { id: string; name: string; path: string; folder: boolean; content?: Content; rev: string;
  modified: string; revisions: { rev: string; modified: string; size: number; content?: Content }[]; thumbnail?: boolean };
type Session = { received: number; parts: Buffer[]; md5: ReturnType<typeof createHash> };

const sizeOf = (c?: Content) => (c === undefined ? 0 : c.kind === 'bytes' ? c.data.length : c.size);
const lower = (p: string) => p.toLowerCase();
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/'));
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const seconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z'); // Dropbox's timestamps have no milliseconds
const asciiJson = (v: unknown) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export class FakeDropbox {
  /** Items by lowercased path; the root ('') is implicit. */
  readonly items = new Map<string, DropboxItem>();
  /** Upload-session requests in order: `start 0+n`, `append <offset>+n`, `finish <offset>+n`. */
  readonly chunks: string[] = [];
  /** Items `delete_v2` moved to Dropbox's deleted files. */
  readonly deleted: DropboxItem[] = [];
  /** `permanently_delete` calls. DropboxBackend must never send one. */
  permanentDeletes = 0;
  quota = { used: 4321, allocated: 2 * 1024 ** 3 };
  private sessions = new Map<string, Session>();

  constructor(private pageSize: number) {}

  private newId = () => `id:${randomBytes(9).toString('base64url')}`;
  private newRev = () => randomBytes(7).toString('hex');
  private childrenOf(dir: string) { return [...this.items.values()].filter((i) => lower(parentOf(i.path)) === lower(dir)); }

  /** The item at `path`, found case-insensitively like Dropbox does. */
  byPath(path: string): DropboxItem | undefined { return this.items.get(lower(path)); }

  /**
   * Adds a file (string/Buffer content, `{ generated: n }` for n pattern bytes, or `null` for a folder) at `path`,
   * creating parent folders.
   */
  put(path: string, content: string | Buffer | null | { generated: number }, o: { thumbnail?: boolean } = {}): DropboxItem {
    this.ensureParents(path);
    const c: Content | undefined = content === null ? undefined : typeof content === 'object' && !Buffer.isBuffer(content)
      ? { kind: 'generated', size: content.generated } : { kind: 'bytes', data: Buffer.from(content) };
    const item = this.create(path, c);
    if (o.thumbnail) item.thumbnail = true;
    return item;
  }

  private ensureParents(path: string) {
    const segs = path.split('/').filter(Boolean);
    let dir = '';
    for (const seg of segs.slice(0, -1)) {
      const existing = this.items.get(lower(`${dir}/${seg}`));
      dir = existing ? existing.path : `${dir}/${seg}`;
      if (!existing) this.create(dir, undefined);
    }
    return dir;
  }

  private create(path: string, content: Content | undefined): DropboxItem {
    const at = seconds(new Date());
    const item: DropboxItem = { id: this.newId(), name: nameOf(path), path, folder: content === undefined, rev: this.newRev(),
      modified: at, revisions: [], ...(content ? { content } : {}) };
    if (content) item.revisions.push({ rev: item.rev, modified: at, size: sizeOf(content), content });
    this.items.set(lower(path), item);
    return item;
  }

  /** Content of a kept file (tests compare it). */
  bytes(path: string): Buffer {
    const c = this.byPath(path)?.content;
    if (c?.kind !== 'bytes') throw new Error(`fake dropbox file ${path} has no kept bytes`);
    return c.data;
  }
  md5(path: string): string | undefined {
    const c = this.byPath(path)?.content;
    return c?.kind === 'bytes' ? createHash('md5').update(c.data).digest('hex') : c?.kind === 'counted' ? c.md5 : undefined;
  }

  /** Metadata as a union member (`Metadata`, with `.tag`): list_folder, get_metadata, search, move, copy, delete. */
  private meta(i: DropboxItem) {
    return { '.tag': i.folder ? 'folder' : 'file', ...this.plain(i) };
  }
  /**
   * Metadata typed as `FileMetadata`/`FolderMetadata` in the Dropbox API has no `.tag`: the download and thumbnail result
   * headers, upload_session/finish, list_revisions entries, restore and create_folder_v2.
   */
  private plain(i: DropboxItem) {
    const base = { name: i.name, id: i.id, path_lower: lower(i.path), path_display: i.path };
    return i.folder ? base : { ...base, rev: i.rev, size: sizeOf(i.content), server_modified: i.modified, client_modified: i.modified };
  }

  /** Moves or copies the item at `from` (and everything beneath it) to `to`. */
  private relocate(from: DropboxItem, to: string, keep: boolean): DropboxItem {
    const fl = lower(from.path);
    for (const [k, i] of [...this.items.entries()]) {
      if (k !== fl && !k.startsWith(`${fl}/`)) continue;
      const path = to + i.path.slice(from.path.length);
      if (!keep) this.items.delete(k);
      const moved: DropboxItem = keep ? { ...i, id: this.newId(), revisions: [...i.revisions] } : i;
      moved.path = path; moved.name = nameOf(path);
      this.items.set(lower(path), moved);
    }
    return this.items.get(lower(to))!;
  }

  private remove(i: DropboxItem) {
    const l = lower(i.path);
    for (const k of [...this.items.keys()]) if (k === l || k.startsWith(`${l}/`)) this.items.delete(k);
  }

  /** `/dropbox/api/2/…` and `/dropbox/content/2/…` with a valid bearer token. Answers false when the path is not Dropbox's. */
  async api(req: http.IncomingMessage, res: http.ServerResponse, u: URL, rec: FakeRequest, account: string, email: string): Promise<boolean> {
    const m = /^\/dropbox\/(api|content)\/2\/(.+)$/.exec(u.pathname);
    if (!m) return false;
    const [, host, endpoint] = m;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    const fail = (summary: string) => json(409, { error_summary: `${summary}/..`, error: { '.tag': summary.split('/')[0] } });
    const bad = (message: string) => res.writeHead(400, { 'content-type': 'text/plain' }).end(message);
    if (req.method !== 'POST') { bad('fake dropbox: POST only'); return true; }

    let arg: Record<string, unknown>;
    let body: AsyncIterable<Buffer> | undefined;
    if (host === 'api') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString();
      if (text !== '' && !String(req.headers['content-type']).startsWith('application/json')) { bad('RPC bodies are JSON'); return true; }
      arg = (text === '' || text === 'null' ? {} : JSON.parse(text)) as Record<string, unknown>;
    } else {
      const raw = req.headers['dropbox-api-arg'];
      if (typeof raw !== 'string' || /[^\x20-\x7e]/.test(raw)) { bad('Dropbox-API-Arg must be ASCII JSON'); return true; }
      arg = JSON.parse(raw) as Record<string, unknown>;
      body = req as AsyncIterable<Buffer>;
    }
    rec.body = arg;
    const pathArg = (k = 'path') => String(arg[k] ?? '');

    switch (`${host} ${endpoint}`) {
      case 'api users/get_current_account':
        json(200, { account_id: `dbid:${account}`, email, name: { display_name: 'Test User' } });
        return true;
      case 'api users/get_space_usage':
        json(200, { used: this.quota.used, allocation: { '.tag': 'individual', allocated: this.quota.allocated } });
        return true;
      case 'api files/list_folder': case 'api files/list_folder/continue': {
        let dir: string; let offset: number; let limit: number;
        if (endpoint === 'files/list_folder') {
          dir = pathArg(); offset = 0; limit = Number(arg.limit ?? 2000);
          if (dir !== '') {
            const d = this.byPath(dir);
            if (!d) { fail('path/not_found'); return true; }
            if (!d.folder) { fail('path/not_folder'); return true; }
          }
        } else {
          const c = JSON.parse(Buffer.from(String(arg.cursor), 'base64url').toString()) as { dir: string; offset: number; limit: number };
          ({ dir, offset, limit } = c);
        }
        const all = this.childrenOf(dir).sort((a, b) => a.path.localeCompare(b.path));
        const size = Math.min(limit, this.pageSize);
        const next = offset + size;
        json(200, { entries: all.slice(offset, next).map((i) => this.meta(i)), has_more: next < all.length,
          cursor: Buffer.from(JSON.stringify({ dir, offset: next, limit })).toString('base64url') });
        return true;
      }
      case 'api files/get_metadata': {
        if (pathArg() === '') { bad('The root folder is unsupported'); return true; }
        const i = this.byPath(pathArg());
        if (!i) { fail('path/not_found'); return true; }
        json(200, this.meta(i));
        return true;
      }
      case 'api files/create_folder_v2': {
        if (this.byPath(pathArg())) { fail('path/conflict/folder'); return true; }
        const dir = this.ensureParents(pathArg());
        json(200, { metadata: this.plain(this.create(`${dir}/${nameOf(pathArg())}`, undefined)) });
        return true;
      }
      case 'api files/move_v2': case 'api files/copy_v2': {
        const from = this.byPath(pathArg('from_path')); const to = pathArg('to_path');
        if (!from) { fail('from_lookup/not_found'); return true; }
        if (lower(to).startsWith(`${lower(from.path)}/`)) { fail('cant_move_folder_into_itself'); return true; }
        // Paths that differ only in case name the same item: refused as a conflict.
        if (this.byPath(to)) { fail('to/conflict/file'); return true; }
        const dir = this.ensureParents(to);
        json(200, { metadata: this.meta(this.relocate(from, `${dir}/${nameOf(to)}`, endpoint === 'files/copy_v2')) });
        return true;
      }
      case 'api files/delete_v2': {
        const i = this.byPath(pathArg());
        if (!i) { fail('path_lookup/not_found'); return true; }
        this.remove(i);
        this.deleted.push(i);
        json(200, { metadata: this.meta(i) });
        return true;
      }
      case 'api files/permanently_delete': {
        this.permanentDeletes++;
        const i = this.byPath(pathArg());
        if (!i) { fail('path_lookup/not_found'); return true; }
        this.remove(i);
        json(200, null);
        return true;
      }
      case 'api files/list_revisions': {
        const i = this.byPath(pathArg());
        if (!i) { fail('path/not_found'); return true; }
        if (i.folder) { fail('path/not_file'); return true; }
        json(200, { is_deleted: false, entries: [...i.revisions].reverse().map((r) => ({ ...this.plain(i), rev: r.rev, size: r.size,
          server_modified: r.modified, client_modified: r.modified })) });
        return true;
      }
      case 'api files/restore': {
        const i = this.byPath(pathArg());
        const r = i?.revisions.find((x) => x.rev === arg.rev);
        if (!i || i.folder || !r?.content) { fail('invalid_revision'); return true; }
        i.content = r.content; i.rev = this.newRev(); i.modified = seconds(new Date(Math.max(Date.now(), Date.parse(i.modified) + 1000)));
        i.revisions.push({ rev: i.rev, modified: i.modified, size: r.size, content: r.content });
        json(200, this.plain(i));
        return true;
      }
      case 'api files/search_v2': case 'api files/search/continue_v2': {
        let query: string; let offset: number; let max: number;
        if (endpoint === 'files/search_v2') {
          query = String(arg.query); offset = 0; max = Number((arg.options as { max_results?: number } | undefined)?.max_results ?? 100);
        } else ({ query, offset, max } = JSON.parse(Buffer.from(String(arg.cursor), 'base64url').toString()) as { query: string; offset: number; max: number });
        const all = [...this.items.values()].filter((i) => i.name.toLowerCase().includes(query.toLowerCase()))
          .sort((a, b) => a.path.localeCompare(b.path));
        const next = offset + Math.min(max, this.pageSize);
        json(200, { matches: all.slice(offset, next).map((i) => ({ metadata: { '.tag': 'metadata', metadata: this.meta(i) } })),
          has_more: next < all.length, cursor: Buffer.from(JSON.stringify({ query, offset: next, max })).toString('base64url') });
        return true;
      }
      case 'content files/download': {
        const i = this.byPath(pathArg());
        if (!i) { fail('path/not_found'); return true; }
        if (i.folder) { fail('path/not_file'); return true; }
        const size = sizeOf(i.content);
        const result = { 'dropbox-api-result': asciiJson(this.plain(i)), 'content-type': 'application/octet-stream' };
        const r = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
        let start = 0; let end = size - 1;
        if (r) {
          start = Number(r[1]); end = r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
          if (start >= size || start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }).end(); return true; }
          res.writeHead(206, { ...result, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
        } else res.writeHead(200, { ...result, 'content-length': size });
        await this.stream(res, i.content!, start, end + 1);
        return true;
      }
      case 'content files/get_thumbnail_v2': {
        const resource = arg.resource as { path?: string } | undefined;
        const i = this.byPath(String(resource?.path ?? ''));
        rec.query = String((arg.size as { '.tag'?: string } | undefined)?.['.tag'] ?? 'w64h64');
        if (!i) { fail('path/not_found'); return true; }
        if (!i.thumbnail || i.content?.kind !== 'bytes') { fail('unsupported_extension'); return true; }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'dropbox-api-result': asciiJson({ file_metadata: this.plain(i) }) }).end(i.content.data);
        return true;
      }
      case 'content files/upload_session/start': {
        const sid = randomBytes(12).toString('hex');
        const s: Session = { received: 0, parts: [], md5: createHash('md5') };
        this.sessions.set(sid, s);
        const got = await this.receive(s, body!);
        this.chunks.push(`start 0+${got}`);
        json(200, { session_id: sid });
        return true;
      }
      case 'content files/upload_session/append_v2': case 'content files/upload_session/finish': {
        const cursor = arg.cursor as { session_id?: string; offset?: number } | undefined;
        const s = this.sessions.get(String(cursor?.session_id));
        if (!s) { fail('lookup_failed/not_found'); return true; }
        if (cursor?.offset !== s.received) { fail('lookup_failed/incorrect_offset'); return true; }
        const got = await this.receive(s, body!);
        this.chunks.push(`${endpoint === 'files/upload_session/finish' ? 'finish' : 'append'} ${cursor.offset}+${got}`);
        if (endpoint === 'files/upload_session/append_v2') { json(200, null); return true; }
        this.sessions.delete(String(cursor.session_id));
        const commit = arg.commit as { path: string; mode?: { '.tag': string; update?: string } | string };
        const mode = typeof commit.mode === 'string' ? { '.tag': commit.mode } : commit.mode ?? { '.tag': 'add' };
        const content: Content = s.received <= KEEP_UPLOAD_BYTES
          ? { kind: 'bytes', data: Buffer.concat(s.parts) } : { kind: 'counted', size: s.received, md5: s.md5.digest('hex') };
        const existing = this.byPath(commit.path);
        if (existing && (existing.folder || mode['.tag'] === 'add' || (mode['.tag'] === 'update' && mode.update !== existing.rev))) {
          fail(`path/conflict/${existing.folder ? 'folder' : 'file'}`); return true;
        }
        if (!existing && mode['.tag'] === 'update') { fail('path/conflict/file'); return true; }
        let i: DropboxItem;
        if (existing) {
          existing.content = content; existing.rev = this.newRev(); existing.modified = seconds(new Date(Math.max(Date.now(), Date.parse(existing.modified) + 1000)));
          existing.revisions.push({ rev: existing.rev, modified: existing.modified, size: s.received, content });
          i = existing;
        } else i = this.create(`${this.ensureParents(commit.path)}/${nameOf(commit.path)}`, content);
        json(200, this.plain(i));
        return true;
      }
    }
    bad(`fake dropbox: no endpoint ${host} ${endpoint}`);
    return true;
  }

  private async receive(s: Session, body: AsyncIterable<Buffer>): Promise<number> {
    let got = 0;
    for await (const chunk of body) {
      got += chunk.length;
      s.md5.update(chunk);
      if (s.received + got <= KEEP_UPLOAD_BYTES) s.parts.push(chunk);
    }
    s.received += got;
    return got;
  }

  // Writes [start, end) of the content with backpressure, so a 1 GB generated file never sits in memory.
  private async stream(res: http.ServerResponse, c: Content, start: number, end: number) {
    if (c.kind === 'counted') throw new Error('fake dropbox keeps no bytes of a counted upload');
    for (let o = start; o < end;) {
      const n = Math.min(end - o, c.kind === 'bytes' ? end - o : BLOCK.length - (o % BLOCK.length));
      const chunk = c.kind === 'bytes' ? c.data.subarray(o, o + n) : BLOCK.subarray(o % BLOCK.length, (o % BLOCK.length) + n);
      o += n;
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      if (res.destroyed) return;
    }
    res.end();
  }
}
