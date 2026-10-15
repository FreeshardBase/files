import type http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import type { FakeRequest } from './fakeProvider.ts';

/** A PNG of one colour, for image fixtures (sharp resolves from the server package, also for e2e/cloudServer.ts). */
export const solidPng = (width: number, height: number, background: string): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();

// The Google Drive v3 subset that GoogleDriveBackend uses (#149), mounted on the fake provider (spec §3.9): files are
// ids with names and parents (so one folder can hold two items of the same name), `q` queries, `pageToken` pagination,
// `alt=media` answered by a 302 to a pre-signed URL that honours Range, exports of Google-native documents, resumable
// upload sessions (308 with `Range` until the last chunk), trash by `trashed: true`, revisions, quota and thumbnails.
// Bearer tokens, injected failures and 401s are handled by the fake provider before a request gets here.
//
// Thumbnails come in Drive's two link shapes (#203): a stored file's `thumbnailLink` is `…/drive-thumb/<id>=s220`
// (Google's `lh3.googleusercontent.com/…=s220`), a Google Doc's, Sheet's or Slides' is `…/feeds/vt?…&sz=s220` (Google's
// `docs.google.com/feeds/vt`), which answers a 302 to a pre-signed image URL. Drive documents that the link of a file
// not shared publicly must be fetched with credentials, so both need the bearer token; the pre-signed hop does not and
// records whether one arrived anyway.

export const FOLDER = 'application/vnd.google-apps.folder';
export const NATIVE = {
  document: 'application/vnd.google-apps.document',
  presentation: 'application/vnd.google-apps.presentation',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  form: 'application/vnd.google-apps.form',
} as const;
const EXPORTABLE: Record<string, string[]> = {
  [NATIVE.document]: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  [NATIVE.spreadsheet]: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
};
/** Session chunks other than the last must be a multiple of this (Drive's rule). */
export const DRIVE_CHUNK_UNIT = 256 * 1024;
/** Uploads above this are counted and hashed, not kept: the 1 GB test must not fill the fake's memory either. */
const KEEP_UPLOAD_BYTES = 16 * 1024 * 1024;

/** Bytes of a generated file: byte `o` is `pattern(o)`, so any range can be produced without storing the file. */
export const generatedByte = (o: number) => (o * 7 + 3) & 0xff;
const BLOCK = Buffer.from(Array.from({ length: 65536 }, (_, i) => generatedByte(i)));

type Content = { kind: 'bytes'; data: Buffer } | { kind: 'generated'; size: number } | { kind: 'counted'; size: number; md5: string };
export type DriveFile = { id: string; name: string; mimeType: string; parents: string[]; trashed: boolean; modifiedTime: string;
  content?: Content; thumbnail?: boolean | Buffer; revisions: { id: string; modifiedTime: string; size: number }[] };
type Session = { fileId?: string; meta: { name?: string; parents?: string[]; mimeType?: string }; size: number; received: number;
  parts: Buffer[]; md5: ReturnType<typeof createHash> };

const sizeOf = (c?: Content) => (c === undefined ? 0 : c.kind === 'bytes' ? c.data.length : c.size);
const LIT = String.raw`'((?:[^'\\]|\\.)*)'`;
const unquote = (s: string) => s.replace(/\\(.)/g, '$1');

export class FakeDrive {
  readonly files = new Map<string, DriveFile>();
  readonly rootId = 'root-' + randomBytes(6).toString('hex');
  /** Session PUTs in order: the `Content-Range` each chunk was sent with. */
  readonly chunks: string[] = [];
  /** Sessions cancelled by the client (`DELETE` on the session URI). */
  cancelled = 0;
  /** Where `alt=media` redirects to; the fake's own pre-signed URL unless a test points it elsewhere. */
  contentOrigin: string | undefined;
  quota = { limit: 15 * 1024 ** 3, usage: 1234 };
  private blobs = new Map<string, string>(); // pre-signed id → file id
  private thumbs = new Map<string, string>(); // pre-signed thumbnail key → file id
  private sessions = new Map<string, Session>();

  constructor(private url: () => string, private pageSize: number) {
    this.files.set(this.rootId, { id: this.rootId, name: 'My Drive', mimeType: FOLDER, parents: [], trashed: false,
      modifiedTime: new Date().toISOString(), revisions: [] });
  }

  private newId = () => randomBytes(12).toString('base64url');
  private live = (f: DriveFile | undefined) => (f && !f.trashed ? f : undefined);
  childrenOf(parent: string) { return [...this.files.values()].filter((f) => !f.trashed && f.parents.includes(parent)); }

  /** The non-trashed item at `path` (first match per name), or undefined. */
  byPath(path: string): DriveFile | undefined {
    let cur: DriveFile | undefined = this.files.get(this.rootId);
    for (const seg of path.split('/').filter(Boolean)) cur = cur && this.childrenOf(cur.id).find((f) => f.name === seg);
    return cur;
  }

  /**
   * Adds a file (string/Buffer content, `{ generated: n }` for n pattern bytes, or `null` for a folder) under `path`,
   * creating parent folders. A second `put` of the same name adds another item with that name (Drive allows it).
   * `thumbnail: true` serves the file's own bytes as its thumbnail; a Buffer is the image Drive rendered (Google Docs).
   */
  put(path: string, content: string | Buffer | null | { generated: number }, o: { mimeType?: string; thumbnail?: boolean | Buffer } = {}): string {
    const segs = path.split('/').filter(Boolean);
    let parent = this.rootId;
    for (const seg of segs.slice(0, -1)) {
      const dir = this.childrenOf(parent).find((f) => f.name === seg && f.mimeType === FOLDER);
      parent = dir ? dir.id : this.create({ name: seg, mimeType: FOLDER, parents: [parent] }).id;
    }
    const c: Content | undefined = content === null ? undefined : typeof content === 'object' && !Buffer.isBuffer(content)
      ? { kind: 'generated', size: content.generated } : { kind: 'bytes', data: Buffer.from(content) };
    const f = this.create({ name: segs.at(-1)!, mimeType: o.mimeType ?? (content === null ? FOLDER : 'application/octet-stream'),
      parents: [parent] }, c);
    if (o.thumbnail) f.thumbnail = o.thumbnail;
    return f.id;
  }

  private create(meta: { name: string; mimeType: string; parents: string[] }, content?: Content): DriveFile {
    const f: DriveFile = { id: this.newId(), ...meta, trashed: false, modifiedTime: new Date().toISOString(), revisions: [],
      ...(content ? { content } : {}) };
    if (content) f.revisions.push({ id: this.newId(), modifiedTime: f.modifiedTime, size: sizeOf(content) });
    this.files.set(f.id, f);
    return f;
  }

  /** Content of a kept file (tests compare it). */
  bytes(id: string): Buffer {
    const c = this.files.get(id)?.content;
    if (c?.kind !== 'bytes') throw new Error(`fake drive file ${id} has no kept bytes`);
    return c.data;
  }
  md5(id: string): string | undefined {
    const c = this.files.get(id)?.content;
    return c?.kind === 'bytes' ? createHash('md5').update(c.data).digest('hex') : c?.kind === 'counted' ? c.md5 : undefined;
  }

  private json(f: DriveFile) {
    const file = f.mimeType !== FOLDER && !f.mimeType.startsWith('application/vnd.google-apps.');
    const md5 = file ? this.md5(f.id) : undefined;
    return { kind: 'drive#file', id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, trashed: f.trashed,
      modifiedTime: f.modifiedTime, ...(file ? { size: String(sizeOf(f.content)) } : {}), ...(md5 ? { md5Checksum: md5 } : {}),
      ...(f.thumbnail ? { thumbnailLink: this.thumbnailLink(f) } : {}) };
  }
  private thumbnailLink(f: DriveFile): string {
    if (!f.mimeType.startsWith('application/vnd.google-apps.')) return `${this.url()}/drive-thumb/${f.id}=s220`;
    const sig = randomBytes(12).toString('base64url');
    return `${this.url()}/feeds/vt?gd=true&id=${encodeURIComponent(f.id)}&v=3&s=${sig}&sz=s220`;
  }
  private thumbImage(f: DriveFile | undefined): Buffer | undefined {
    if (Buffer.isBuffer(f?.thumbnail)) return f.thumbnail;
    return f?.thumbnail && f.content?.kind === 'bytes' ? f.content.data : undefined;
  }

  /** The two thumbnailLink shapes, reached with a valid bearer token. Answers false for other paths. */
  thumbnail(req: http.IncomingMessage, res: http.ServerResponse, u: URL, rec: FakeRequest): boolean {
    if (req.method !== 'GET') return false;
    const notFound = () => res.writeHead(404, { 'content-type': 'text/html' }).end('<html>Not Found</html>');
    const direct = /^\/drive-thumb\/([A-Za-z0-9_-]+)=s(\d+)$/.exec(u.pathname);
    if (direct) {
      rec.query = `s${direct[2]}`;
      const img = this.thumbImage(this.files.get(direct[1]!));
      if (!img) notFound();
      else res.writeHead(200, { 'content-type': 'image/png' }).end(img);
      return true;
    }
    if (u.pathname === '/feeds/vt') {
      const id = u.searchParams.get('id') ?? '';
      const sz = /^s(\d+)$/.exec(u.searchParams.get('sz') ?? '');
      rec.query = sz ? `s${sz[1]}` : u.search;
      if (!this.thumbImage(this.files.get(id)) || !sz) { notFound(); return true; }
      const key = randomBytes(18).toString('base64url');
      this.thumbs.set(key, id);
      res.writeHead(302, { location: `${this.contentOrigin ?? this.url()}/drive-thumb-signed/${key}=s${sz[1]}` }).end();
      return true;
    }
    return false;
  }

  private query(q: string): DriveFile[] {
    let out = [...this.files.values()].filter((f) => f.id !== this.rootId);
    const parent = new RegExp(`${LIT} in parents`).exec(q);
    if (parent) out = out.filter((f) => f.parents.includes(unquote(parent[1]!) === 'root' ? this.rootId : unquote(parent[1]!)));
    const names = [...q.matchAll(new RegExp(`name = ${LIT}`, 'g'))].map((m) => unquote(m[1]!));
    if (names.length) out = out.filter((f) => names.includes(f.name));
    const contains = new RegExp(`name contains ${LIT}`).exec(q);
    if (contains) out = out.filter((f) => f.name.toLowerCase().includes(unquote(contains[1]!).toLowerCase()));
    if (/trashed = false/.test(q)) out = out.filter((f) => !f.trashed);
    return out.sort((a, b) => Number(b.mimeType === FOLDER) - Number(a.mimeType === FOLDER) || a.name.localeCompare(b.name)
      || a.id.localeCompare(b.id));
  }

  private target(id: string) { return this.files.get(id === 'root' ? this.rootId : id); }
  private touch(f: DriveFile) { f.modifiedTime = new Date(Math.max(Date.now(), Date.parse(f.modifiedTime) + 1)).toISOString(); }

  /** `/drive/v3/...` and `/upload/drive/v3/...` with a valid bearer token. Answers false when the path is not Drive's. */
  async api(req: http.IncomingMessage, res: http.ServerResponse, u: URL, rec: FakeRequest, account: string, email: string): Promise<boolean> {
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    const notFound = () => json(404, { error: { code: 404, message: 'File not found', errors: [{ reason: 'notFound' }] } });
    const body = async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = chunks.map((c) => c.toString()).join('');
      rec.body = text ? JSON.parse(text) as Record<string, unknown> : {};
      return rec.body as Record<string, unknown>;
    };
    const q = u.searchParams;
    rec.query = u.search;
    const m = /^\/(upload\/)?drive\/v3\/(about|files)(?:\/([^/]+))?(?:\/(export|copy|revisions))?$/.exec(u.pathname);
    if (!m) return false;
    const [, upload, kind, id, sub] = m;
    const key = `${req.method} ${upload ? 'upload ' : ''}${kind}${id ? ' :id' : ''}${sub ? ' ' + sub : ''}`;
    switch (key) {
      case 'GET about':
        json(200, { user: { permissionId: `perm-${account}`, emailAddress: email, displayName: 'Test User' },
          storageQuota: { limit: String(this.quota.limit), usage: String(this.quota.usage) } });
        return true;
      case 'GET files': {
        const all = this.query(q.get('q') ?? '');
        const size = Math.min(Number(q.get('pageSize') ?? 100), this.pageSize);
        const start = Number(q.get('pageToken') ?? 0);
        json(200, { files: all.slice(start, start + size).map((f) => this.json(f)),
          ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}) });
        return true;
      }
      case 'GET files :id': {
        const f = this.target(id!);
        if (!f) { notFound(); return true; }
        if (q.get('alt') !== 'media') { json(200, this.json(f)); return true; }
        if (f.mimeType.startsWith('application/vnd.google-apps.')) {
          json(403, { error: { code: 403, errors: [{ reason: 'fileNotDownloadable' }] } }); return true;
        }
        const token = randomBytes(18).toString('base64url');
        this.blobs.set(token, f.id);
        res.writeHead(302, { location: `${this.contentOrigin ?? this.url()}/drive-blob/${token}` }).end();
        return true;
      }
      case 'GET files :id export': {
        const f = this.live(this.target(id!));
        if (!f) { notFound(); return true; }
        const mime = q.get('mimeType') ?? '';
        if (!EXPORTABLE[f.mimeType]?.includes(mime)) { json(400, { error: { code: 400, errors: [{ reason: 'badRequest' }] } }); return true; }
        res.writeHead(200, { 'content-type': mime }).end(`exported ${f.name} as ${mime}`);
        return true;
      }
      case 'GET files :id revisions': {
        const f = this.target(id!);
        if (!f) { notFound(); return true; }
        json(200, { revisions: f.revisions.map((r) => ({ id: r.id, modifiedTime: r.modifiedTime, size: String(r.size) })) });
        return true;
      }
      case 'POST files': {
        const b = await body();
        const f = this.create({ name: String(b.name), mimeType: String(b.mimeType ?? 'application/octet-stream'),
          parents: (b.parents as string[] | undefined)?.map((p) => (p === 'root' ? this.rootId : p)) ?? [this.rootId] });
        json(200, this.json(f));
        return true;
      }
      case 'PATCH files :id': {
        const f = this.target(id!);
        if (!f || f.id === this.rootId) { notFound(); return true; }
        const b = await body();
        if (typeof b.name === 'string') f.name = b.name;
        if (typeof b.trashed === 'boolean') f.trashed = b.trashed;
        const add = q.get('addParents'); const remove = q.get('removeParents');
        if (remove) f.parents = f.parents.filter((p) => !remove.split(',').includes(p));
        if (add) f.parents.push(...add.split(',').map((p) => (p === 'root' ? this.rootId : p)));
        this.touch(f);
        json(200, this.json(f));
        return true;
      }
      case 'POST files :id copy': {
        const f = this.live(this.target(id!));
        if (!f) { notFound(); return true; }
        const b = await body();
        const c = this.create({ name: typeof b.name === 'string' ? b.name : f.name, mimeType: f.mimeType,
          parents: (b.parents as string[] | undefined) ?? f.parents }, f.content);
        json(200, this.json(c));
        return true;
      }
      case 'DELETE files :id': {
        // Permanent delete. GoogleDriveBackend must never send it; the test asserts it never arrives.
        const f = this.target(id!);
        if (!f) { notFound(); return true; }
        this.files.delete(f.id);
        res.writeHead(204).end();
        return true;
      }
      case 'POST upload files': case 'PATCH upload files :id': {
        if (q.get('uploadType') !== 'resumable') { json(400, { error: { code: 400 } }); return true; }
        const b = await body();
        const size = Number(req.headers['x-upload-content-length']);
        if (!Number.isSafeInteger(size)) { json(400, { error: { code: 400, message: 'X-Upload-Content-Length required' } }); return true; }
        if (id && !this.live(this.target(id))) { notFound(); return true; }
        const sid = randomBytes(18).toString('base64url');
        this.sessions.set(sid, { ...(id ? { fileId: id } : {}), meta: b as Session['meta'], size, received: 0, parts: [],
          md5: createHash('md5') });
        res.writeHead(200, { location: `${this.url()}/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}` }).end();
        return true;
      }
    }
    json(404, { error: { code: 404, message: `fake drive: no route ${key}` } });
    return true;
  }

  /** Pre-signed URLs (no bearer token): content blobs, upload sessions and redirected thumbnails. Answers false for other paths. */
  async presigned(req: http.IncomingMessage, res: http.ServerResponse, u: URL, rec: FakeRequest): Promise<boolean> {
    const json = (status: number, body: unknown, headers: Record<string, string | number> = {}) =>
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    if (u.pathname === '/upload/drive/v3/files' && u.searchParams.has('upload_id')) {
      const sid = u.searchParams.get('upload_id')!;
      const s = this.sessions.get(sid);
      if (!s) { json(404, { error: { code: 404 } }); return true; }
      if (req.method === 'DELETE') { this.sessions.delete(sid); this.cancelled++; res.writeHead(499).end(); return true; }
      if (req.method !== 'PUT') { json(405, {}); return true; }
      const range = String(req.headers['content-range'] ?? '');
      rec.query = range;
      this.chunks.push(range);
      const status = /^bytes \*\/(\d+)$/.exec(range);
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      let got = 0;
      for await (const c of req) {
        const chunk = c as Buffer;
        got += chunk.length;
        s.md5.update(chunk);
        if (s.size <= KEEP_UPLOAD_BYTES) s.parts.push(chunk);
      }
      if (status && Number(status[1]) !== s.size) { json(400, { error: { code: 400, message: 'size differs' } }); return true; }
      if (!status) {
        if (!m || Number(m[1]) !== s.received || Number(m[3]) !== s.size || Number(m[2]) - Number(m[1]) + 1 !== got) {
          json(400, { error: { code: 400, message: 'bad content-range' } }); return true;
        }
        const last = Number(m[2]) + 1 === s.size;
        if (!last && got % DRIVE_CHUNK_UNIT !== 0) { json(400, { error: { code: 400, message: 'chunk not a multiple of 256 KiB' } }); return true; }
        s.received += got;
      }
      if (s.received < s.size) {
        res.writeHead(308, s.received > 0 ? { range: `bytes=0-${s.received - 1}` } : {}).end();
        return true;
      }
      this.sessions.delete(sid);
      const content: Content = s.size <= KEEP_UPLOAD_BYTES
        ? { kind: 'bytes', data: Buffer.concat(s.parts) } : { kind: 'counted', size: s.size, md5: s.md5.digest('hex') };
      let f: DriveFile;
      if (s.fileId) {
        f = this.target(s.fileId)!;
        f.content = content; this.touch(f);
        f.revisions.push({ id: this.newId(), modifiedTime: f.modifiedTime, size: s.size });
      } else {
        f = this.create({ name: String(s.meta.name), mimeType: s.meta.mimeType ?? String(req.headers['x-upload-content-type'] ?? 'application/octet-stream'),
          parents: s.meta.parents?.map((p) => (p === 'root' ? this.rootId : p)) ?? [this.rootId] }, content);
      }
      json(200, this.json(f));
      return true;
    }
    const blob = /^\/drive-blob\/([A-Za-z0-9_-]+)$/.exec(u.pathname);
    if (blob && req.method === 'GET') {
      const f = this.files.get(this.blobs.get(blob[1]!) ?? '');
      if (!f?.content) { json(404, {}); return true; }
      const size = sizeOf(f.content);
      const r = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
      let start = 0; let end = size - 1;
      if (r) {
        start = Number(r[1]); end = r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
        if (start >= size || start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }).end(); return true; }
        res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      } else res.writeHead(200, { 'content-length': size });
      await this.stream(res, f.content, start, end + 1);
      return true;
    }
    const signed = /^\/drive-thumb-signed\/([A-Za-z0-9_-]+)=s\d+$/.exec(u.pathname);
    if (signed && req.method === 'GET') {
      // The URL is the capability; a bearer token sent here anyway is recorded, so a test can show none arrives.
      rec.token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const img = this.thumbImage(this.files.get(this.thumbs.get(signed[1]!) ?? ''));
      if (!img) { json(404, {}); return true; }
      res.writeHead(200, { 'content-type': 'image/png' }).end(img);
      return true;
    }
    return false;
  }

  // Writes [start, end) of the content with backpressure, so a 1 GB generated file never sits in memory.
  private async stream(res: http.ServerResponse, c: Content, start: number, end: number) {
    if (c.kind === 'counted') throw new Error('fake drive keeps no bytes of a counted upload');
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
