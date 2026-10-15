import type http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { FakeRequest } from './fakeProvider.ts';
import { generatedByte } from './fakeDrive.ts';

// The Microsoft Graph subset that GraphBackend uses (#151), mounted on the fake provider (spec §3.9) under
// `/graph/v1.0/…`: the account's OneDrive (`/me/drive`) and SharePoint document libraries (`/drives/{id}`) of sites
// found by `/sites?search=`. Items are ids with a parent, addressed by id or by path (`root:/a/b:`), and names ignore
// case like OneDrive's. Listings page through `@odata.nextLink`; content and thumbnails answer with a 302 to a
// pre-signed URL that honours Range; uploads go through `createUploadSession` (pre-signed, `Content-Range` chunks in
// multiples of 320 KiB); copies are asynchronous behind a monitor URL; delete moves into the recycle bin. Bearer tokens,
// injected failures and 401s are handled by the fake provider before a request gets here.

/** Graph wants every upload-session chunk but the last in multiples of 320 KiB. */
export const GRAPH_CHUNK_UNIT = 320 * 1024;
/** Uploads above this are counted and hashed, not kept: the 1 GB test must not fill the fake's memory either. */
const KEEP_UPLOAD_BYTES = 16 * 1024 * 1024;
const BLOCK = Buffer.from(Array.from({ length: 65536 }, (_, i) => generatedByte(i)));
/** The account's OneDrive. */
export const ONEDRIVE_ID = 'b!onedrive-testuser';

type Content = { kind: 'bytes'; data: Buffer } | { kind: 'generated'; size: number } | { kind: 'counted'; size: number; md5: string };
export type GraphItem = { id: string; drive: string; name: string; parent: string | null; folder: boolean; content?: Content; rev: number;
  modified: string; versions: { id: string; modified: string; size: number }[]; thumbnail?: boolean };
type Session = { drive: string; parent: string; name: string; conflict: string; received: number; parts: Buffer[];
  md5: ReturnType<typeof createHash> };
type Site = { id: string; displayName: string; webUrl: string; drives: { id: string; name: string }[] };

const sizeOf = (c?: Content) => (c === undefined ? 0 : c.kind === 'bytes' ? c.data.length : c.size);
const lower = (s: string) => s.toLowerCase();
const conflictOf = (v: unknown) => (typeof v === 'string' ? v : 'fail');

export class FakeGraph {
  /** Every item of every drive, by id. */
  readonly items = new Map<string, GraphItem>();
  /** The SharePoint sites `/sites?search=` finds, with their document libraries. */
  readonly sites: Site[] = [];
  /** Upload-session chunks in order, as their `Content-Range` (`bytes a-b/total`). */
  readonly chunks: string[] = [];
  /** Items DELETE moved into the recycle bin. */
  readonly recycled: GraphItem[] = [];
  /** `permanentDelete` calls. GraphBackend must never send one. */
  permanentDeletes = 0;
  /** Upload sessions cancelled with DELETE on the session URL. */
  cancelledSessions = 0;
  /** Monitor polls answered "inProgress" before a copy reports "completed". */
  copyPollsBeforeDone = 2;
  monitorPolls = 0;
  /** The next listing's `@odata.nextLink` points off the Graph API (the backend must not follow it). */
  foreignNextLink = false;
  /** The next content redirect points at another origin than the fake's (the backend must not follow it). */
  foreignRedirect = false;
  quota = { used: 9876, total: 5 * 1024 ** 3 };
  private roots = new Map<string, string>(); // drive → root id
  private sessions = new Map<string, Session>();
  private blobs = new Map<string, { id: string; thumb: boolean }>();
  private monitors = new Map<string, { target: string; error?: string; polls: number }>();

  constructor(private url: () => string, private pageSize: number) {
    this.addDrive(ONEDRIVE_ID);
  }

  private newId = () => randomBytes(9).toString('hex').toUpperCase();
  private addDrive(drive: string) {
    const root: GraphItem = { id: this.newId(), drive, name: 'root', parent: null, folder: true, rev: 1, modified: new Date().toISOString(), versions: [] };
    this.items.set(root.id, root);
    this.roots.set(drive, root.id);
  }

  /** A SharePoint site with document libraries (`[driveId, name]`), found by `/sites?search=`. */
  addSite(id: string, displayName: string, libraries: [string, string][]): void {
    this.sites.push({ id, displayName, webUrl: `https://contoso.sharepoint.com/sites/${displayName.replace(/\s/g, '')}`,
      drives: libraries.map(([d, name]) => ({ id: d, name })) });
    for (const [d] of libraries) this.addDrive(d);
  }

  private childrenOf(id: string) { return [...this.items.values()].filter((i) => i.parent === id); }
  private child(parent: string, name: string) { return this.childrenOf(parent).find((i) => lower(i.name) === lower(name)); }
  private pathOf(i: GraphItem): string {
    const segs: string[] = [];
    for (let c: GraphItem | undefined = i; c && c.parent !== null; c = this.items.get(c.parent)) segs.unshift(c.name);
    return `/${segs.join('/')}`;
  }

  /** The item at `path` in `drive` (the OneDrive by default), found ignoring case like OneDrive does. */
  byPath(path: string, drive = ONEDRIVE_ID): GraphItem | undefined {
    let cur = this.items.get(this.roots.get(drive)!);
    for (const seg of path.split('/').filter(Boolean)) {
      cur = cur && this.child(cur.id, seg);
    }
    return cur;
  }

  /**
   * Adds a file (string/Buffer content, `{ generated: n }` for n pattern bytes, or `null` for a folder) at `path` of
   * `drive`, creating parent folders and replacing an item of that name.
   */
  put(path: string, content: string | Buffer | null | { generated: number }, o: { drive?: string; thumbnail?: boolean } = {}): GraphItem {
    const drive = o.drive ?? ONEDRIVE_ID;
    const segs = path.split('/').filter(Boolean);
    let parent = this.roots.get(drive)!;
    for (const seg of segs.slice(0, -1)) parent = (this.child(parent, seg) ?? this.create(drive, parent, seg, undefined)).id;
    const c: Content | undefined = content === null ? undefined : typeof content === 'object' && !Buffer.isBuffer(content)
      ? { kind: 'generated', size: content.generated } : { kind: 'bytes', data: Buffer.from(content) };
    const old = this.child(parent, segs.at(-1)!);
    if (old) this.remove(old); // a put replaces what was there
    const item = this.create(drive, parent, segs.at(-1)!, c);
    if (o.thumbnail) item.thumbnail = true;
    return item;
  }

  private create(drive: string, parent: string, name: string, content: Content | undefined): GraphItem {
    const at = new Date().toISOString();
    const item: GraphItem = { id: this.newId(), drive, name, parent, folder: content === undefined, rev: 1, modified: at, versions: [],
      ...(content ? { content } : {}) };
    if (content) item.versions.push({ id: '1.0', modified: at, size: sizeOf(content) });
    this.items.set(item.id, item);
    return item;
  }

  /** Content of a kept file (tests compare it). */
  bytes(path: string, drive?: string): Buffer {
    const c = this.byPath(path, drive)?.content;
    if (c?.kind !== 'bytes') throw new Error(`fake graph file ${path} has no kept bytes`);
    return c.data;
  }
  md5(path: string, drive?: string): string | undefined {
    const c = this.byPath(path, drive)?.content;
    return c?.kind === 'bytes' ? createHash('md5').update(c.data).digest('hex') : c?.kind === 'counted' ? c.md5 : undefined;
  }

  private json(i: GraphItem) {
    const base = { id: i.id, name: i.name, eTag: `"{${i.id}},${i.rev}"`, cTag: `"c:{${i.id}},${i.rev}"`, lastModifiedDateTime: i.modified,
      size: i.folder ? this.childrenOf(i.id).reduce((n, c) => n + sizeOf(c.content), 0) : sizeOf(i.content) };
    if (i.parent === null) return { ...base, root: {}, folder: { childCount: this.childrenOf(i.id).length }, parentReference: { driveId: i.drive } };
    const parent = this.items.get(i.parent)!;
    const parentPath = this.pathOf(parent);
    return { ...base, parentReference: { driveId: i.drive, id: i.parent, path: `/drives/${i.drive}/root:${parentPath === '/' ? '' : parentPath}` },
      ...(i.folder ? { folder: { childCount: this.childrenOf(i.id).length } } : { file: { mimeType: 'application/octet-stream' } }) };
  }

  /** Moves or copies `i` (and everything beneath it) into `parent` under `name`. */
  private relocate(i: GraphItem, parent: string, name: string, keep: boolean): GraphItem {
    if (!keep) { i.parent = parent; i.name = name; i.rev++; return i; }
    const copy = (src: GraphItem, into: string, as: string): GraphItem => {
      const c: GraphItem = { ...src, id: this.newId(), parent: into, name: as, versions: [...src.versions] };
      this.items.set(c.id, c);
      for (const k of this.childrenOf(src.id)) copy(k, c.id, k.name);
      return c;
    };
    return copy(i, parent, name);
  }

  private remove(i: GraphItem) {
    for (const k of this.childrenOf(i.id)) this.remove(k);
    this.items.delete(i.id);
  }

  /** `/graph/v1.0/…` with a valid bearer token. Answers false when the path is not Graph's. */
  async api(req: http.IncomingMessage, res: http.ServerResponse, u: URL, rec: FakeRequest, account: string, email: string): Promise<boolean> {
    if (!u.pathname.startsWith('/graph/v1.0/')) return false;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    const fail = (status: number, code: string) => json(status, { error: { code, message: code } });
    const method = req.method ?? 'GET';
    const rest = u.pathname.slice('/graph/v1.0'.length);
    let body: Record<string, unknown> = {};
    let raw: Buffer | undefined;
    // An upload by path (`:/content`) carries bytes; everything else carries JSON.
    if (method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      raw = Buffer.concat(chunks);
    } else if (method === 'POST' || method === 'PATCH') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString();
      if (text !== '' && !String(req.headers['content-type']).startsWith('application/json')) { fail(400, 'invalidRequest'); return true; }
      body = (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>;
      rec.body = body;
    }

    if (method === 'GET' && rest === '/me') {
      json(200, { id: `ms-${account}`, displayName: 'Test User', mail: email, userPrincipalName: email });
      return true;
    }
    if (method === 'GET' && rest === '/sites') {
      const q = lower(u.searchParams.get('search') ?? '');
      const found = this.sites.filter((s) => q === '*' || lower(s.displayName).includes(q));
      json(200, { value: found.map((s) => ({ id: s.id, displayName: s.displayName, webUrl: s.webUrl, name: s.displayName })) });
      return true;
    }
    const site = /^\/sites\/([^/]+)(\/drives)?$/.exec(rest);
    if (method === 'GET' && site) {
      const s = this.sites.find((x) => x.id === decodeURIComponent(site[1]!));
      if (!s) { fail(404, 'itemNotFound'); return true; }
      if (!site[2]) { json(200, { id: s.id, displayName: s.displayName, webUrl: s.webUrl }); return true; }
      json(200, { value: s.drives.map((d) => ({ id: d.id, name: d.name, driveType: 'documentLibrary' })) });
      return true;
    }

    const d = /^\/(?:me\/drive|drives\/([^/]+))(\/.*)?$/.exec(rest);
    if (!d) { fail(400, `fake graph: no endpoint ${rest}`); return true; }
    const drive = d[1] === undefined ? ONEDRIVE_ID : decodeURIComponent(d[1]);
    if (!this.roots.has(drive)) { fail(404, 'itemNotFound'); return true; }
    const base = d[1] === undefined ? '/me/drive' : `/drives/${d[1]}`;
    const tail = d[2] ?? '';
    if (tail === '' && method === 'GET') {
      json(200, { id: drive, driveType: drive === ONEDRIVE_ID ? 'personal' : 'documentLibrary',
        quota: { used: this.quota.used, total: this.quota.total, remaining: this.quota.total - this.quota.used, state: 'normal' } });
      return true;
    }
    const search = /^\/root\/search\(q='(.*)'\)$/.exec(tail);
    if (search && method === 'GET') {
      const q = lower(decodeURIComponent(search[1]!).replace(/''/g, "'"));
      const all = [...this.items.values()].filter((i) => i.drive === drive && i.parent !== null && lower(i.name).includes(q))
        .sort((a, b) => this.pathOf(a).localeCompare(this.pathOf(b)));
      // Like Graph's search, results carry no parent path; the backend walks the parents.
      this.page(res, u, all, (i) => { const { parentReference, ...j } = this.json(i); return { ...j, parentReference: { driveId: i.drive, id: parentReference.id } }; },
        (skip) => `${this.url()}/graph/v1.0${base}${tail}?$skiptoken=${skip}`);
      return true;
    }

    // The addressed item and what is asked of it: by path (`/root:/a/b:/suffix`), as the root, or by id.
    let item: GraphItem | undefined;
    let suffix: string;
    let pathTarget: { parent: GraphItem | undefined; name: string } | undefined;
    if (tail.startsWith('/root:')) {
      const after = tail.slice('/root:'.length);
      const colon = after.indexOf(':');
      const enc = colon < 0 ? after : after.slice(0, colon);
      suffix = colon < 0 ? '' : after.slice(colon + 1);
      const segs = enc.split('/').filter(Boolean).map(decodeURIComponent);
      item = this.byPath(segs.join('/'), drive);
      pathTarget = { parent: this.byPath(segs.slice(0, -1).join('/'), drive), name: segs.at(-1) ?? '' };
    } else if (tail === '/root' || tail.startsWith('/root/')) {
      item = this.items.get(this.roots.get(drive)!); suffix = tail.slice('/root'.length);
    } else {
      const m = /^\/items\/([^/]+)(\/.*)?$/.exec(tail);
      if (!m) { fail(400, `fake graph: no endpoint ${tail}`); return true; }
      item = this.items.get(decodeURIComponent(m[1]!));
      if (item && item.drive !== drive) item = undefined;
      suffix = m[2] ?? '';
    }

    if (method === 'POST' && suffix === '/createUploadSession') {
      if (!pathTarget?.parent?.folder) { fail(404, 'itemNotFound'); return true; }
      const ifMatch = req.headers['if-match'];
      if (ifMatch !== undefined && (!item || ifMatch !== this.json(item).eTag)) { fail(412, 'resourceModified'); return true; }
      const sid = randomBytes(12).toString('hex');
      this.sessions.set(sid, { drive, parent: pathTarget.parent.id, name: pathTarget.name, received: 0,
        conflict: conflictOf((body.item as Record<string, unknown> | undefined)?.['@microsoft.graph.conflictBehavior']), parts: [], md5: createHash('md5') });
      json(200, { uploadUrl: `${this.url()}/graph-upload/${sid}`, expirationDateTime: new Date(Date.now() + 3600_000).toISOString() });
      return true;
    }
    if (method === 'PUT' && suffix === '/content') {
      if (!pathTarget?.parent?.folder) { fail(404, 'itemNotFound'); return true; }
      const placed = this.place(drive, pathTarget.parent.id, pathTarget.name, conflictOf(u.searchParams.get('@microsoft.graph.conflictBehavior')),
        { kind: 'bytes', data: raw! });
      if (typeof placed === 'string') { fail(409, placed); return true; }
      json(placed.created ? 201 : 200, this.json(placed.item));
      return true;
    }
    if (!item) { fail(404, 'itemNotFound'); return true; }

    switch (`${method} ${suffix}`) {
      case 'GET ': json(200, this.json(item)); return true;
      case 'GET /children': {
        if (!item.folder) { fail(400, 'invalidRequest'); return true; }
        const all = this.childrenOf(item.id).sort((a, b) => a.name.localeCompare(b.name));
        const top = Number(u.searchParams.get('$top') ?? 200);
        const foreign = this.foreignNextLink; this.foreignNextLink = false;
        this.page(res, u, all, (i) => this.json(i), (skip) => `${foreign ? `${this.url()}/elsewhere` : `${this.url()}/graph/v1.0`}${base}/items/${item.id}/children?$top=${top}&$skiptoken=${skip}`, top);
        return true;
      }
      case 'POST /children': {
        if (!item.folder) { fail(400, 'invalidRequest'); return true; }
        const name = String(body.name ?? '');
        if (this.child(item.id, name)) { fail(409, 'nameAlreadyExists'); return true; }
        json(201, this.json(this.create(drive, item.id, name, undefined)));
        return true;
      }
      case 'PATCH ': {
        const parentRef = body.parentReference as { id?: string } | undefined;
        const parent = parentRef?.id !== undefined ? this.items.get(parentRef.id) : this.items.get(item.parent ?? '');
        if (!parent?.folder || parent.drive !== drive) { fail(404, 'itemNotFound'); return true; }
        for (let p: GraphItem | undefined = parent; p; p = p.parent === null ? undefined : this.items.get(p.parent)) {
          if (p.id === item.id) { fail(400, 'invalidRequest'); return true; }
        }
        const name = typeof body.name === 'string' ? body.name : item.name;
        const taken = this.child(parent.id, name);
        if (taken && taken.id !== item.id) { fail(409, 'nameAlreadyExists'); return true; }
        json(200, this.json(this.relocate(item, parent.id, name, false)));
        return true;
      }
      case 'DELETE ': {
        if (item.parent === null) { fail(403, 'accessDenied'); return true; }
        this.remove(item);
        this.recycled.push(item);
        res.writeHead(204).end();
        return true;
      }
      case 'POST /permanentDelete': {
        this.permanentDeletes++;
        this.remove(item);
        res.writeHead(204).end();
        return true;
      }
      case 'POST /copy': {
        const parentRef = body.parentReference as { id?: string; driveId?: string } | undefined;
        const parent = this.items.get(parentRef?.id ?? '');
        if (!parent?.folder || parent.drive !== drive || parentRef?.driveId !== drive) { fail(400, 'invalidRequest'); return true; }
        const name = typeof body.name === 'string' ? body.name : item.name;
        const mid = randomBytes(9).toString('hex');
        if (this.child(parent.id, name)) this.monitors.set(mid, { target: '', error: 'nameAlreadyExists', polls: 0 });
        else this.monitors.set(mid, { target: this.relocate(item, parent.id, name, true).id, polls: 0 });
        res.writeHead(202, { location: `${this.url()}/graph-monitor/${mid}` }).end();
        return true;
      }
      case 'GET /content': {
        if (item.folder) { fail(400, 'invalidRequest'); return true; }
        this.redirect(res, item.id, false);
        return true;
      }
      case 'GET /versions': {
        if (item.folder) { fail(400, 'invalidRequest'); return true; }
        json(200, { value: [...item.versions].reverse().map((v) => ({ id: v.id, lastModifiedDateTime: v.modified, size: v.size })) });
        return true;
      }
    }
    const thumb = /^\/thumbnails\/0\/(small|medium|large)\/content$/.exec(suffix);
    if (method === 'GET' && thumb) {
      rec.query = thumb[1];
      if (!item.thumbnail) { fail(404, 'itemNotFound'); return true; }
      this.redirect(res, item.id, true);
      return true;
    }
    fail(400, `fake graph: no endpoint ${method} ${suffix}`);
    return true;
  }

  private page<T>(res: http.ServerResponse, u: URL, all: T[], view: (x: T) => unknown, next: (skip: number) => string, top = 200) {
    const offset = Number(u.searchParams.get('$skiptoken') ?? 0);
    const end = offset + Math.min(top, this.pageSize);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value: all.slice(offset, end).map(view),
      ...(end < all.length ? { '@odata.nextLink': next(end) } : {}) }));
  }

  private redirect(res: http.ServerResponse, id: string, thumb: boolean) {
    const token = randomBytes(12).toString('hex');
    this.blobs.set(token, { id, thumb });
    const origin = this.foreignRedirect ? this.url().replace('127.0.0.1', 'localhost') : this.url();
    this.foreignRedirect = false;
    res.writeHead(302, { location: `${origin}/graph-dl/${token}` }).end();
  }

  /** Puts finished bytes at `name` in `parent` under the conflict behaviour; an error code when it is refused. */
  private place(drive: string, parent: string, name: string, conflict: string, content: Content): { item: GraphItem; created: boolean } | string {
    const existing = this.child(parent, name);
    if (existing && (existing.folder || conflict === 'fail')) return 'nameAlreadyExists';
    if (existing) {
      existing.content = content; existing.rev++;
      existing.modified = new Date(Math.max(Date.now(), Date.parse(existing.modified) + 1000)).toISOString();
      existing.versions.push({ id: `${existing.versions.length + 1}.0`, modified: existing.modified, size: sizeOf(content) });
      return { item: existing, created: false };
    }
    return { item: this.create(drive, parent, name, content), created: true };
  }

  /** Pre-signed URLs, like Graph's: no bearer token, the URL itself is the capability. False when not Graph's. */
  async presigned(req: http.IncomingMessage, res: http.ServerResponse, u: URL, rec: FakeRequest): Promise<boolean> {
    const [, kind, id] = u.pathname.split('/');
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (kind !== 'graph-dl' && kind !== 'graph-upload' && kind !== 'graph-monitor') return false;
    if (req.headers.authorization !== undefined) { json(400, { error: { code: 'invalidRequest', message: 'pre-signed URLs take no token' } }); return true; }
    if (kind === 'graph-dl' && req.method === 'GET') {
      const blob = this.blobs.get(id ?? '');
      const item = blob && this.items.get(blob.id);
      if (!blob || !item?.content) { json(404, { error: { code: 'itemNotFound' } }); return true; }
      const size = sizeOf(item.content);
      const r = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
      let start = 0; let end = size - 1;
      if (r && !blob.thumb) {
        start = Number(r[1]); end = r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
        if (start >= size || start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }).end(); return true; }
        res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      } else res.writeHead(200, { 'content-length': size, 'content-type': 'application/octet-stream' });
      await this.stream(res, item.content, start, end + 1);
      return true;
    }
    if (kind === 'graph-upload') {
      const s = this.sessions.get(id ?? '');
      if (!s) { json(404, { error: { code: 'itemNotFound' } }); return true; }
      if (req.method === 'DELETE') { this.sessions.delete(id!); this.cancelledSessions++; res.writeHead(204).end(); return true; }
      if (req.method !== 'PUT') return false;
      const range = String(req.headers['content-range'] ?? '');
      rec.query = range;
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      const length = Number(req.headers['content-length'] ?? NaN);
      if (!m || Number(m[1]) !== s.received || Number(m[2]) - Number(m[1]) + 1 !== length) {
        req.resume();
        json(416, { error: { code: 'invalidRange' }, nextExpectedRanges: [`${s.received}-`] }); return true;
      }
      const total = Number(m[3]);
      const last = Number(m[2]) + 1 === total;
      if (!last && length % GRAPH_CHUNK_UNIT !== 0) {
        req.resume();
        json(400, { error: { code: 'invalidRequest', message: 'chunks must be multiples of 320 KiB' } }); return true;
      }
      for await (const chunk of req) {
        const c = chunk as Buffer;
        s.md5.update(c);
        if (s.received + c.length <= KEEP_UPLOAD_BYTES) s.parts.push(c);
        s.received += c.length;
      }
      this.chunks.push(range);
      if (!last) { json(202, { expirationDateTime: new Date(Date.now() + 3600_000).toISOString(), nextExpectedRanges: [`${s.received}-`] }); return true; }
      this.sessions.delete(id!);
      const content: Content = s.received <= KEEP_UPLOAD_BYTES
        ? { kind: 'bytes', data: Buffer.concat(s.parts) } : { kind: 'counted', size: s.received, md5: s.md5.digest('hex') };
      const placed = this.place(s.drive, s.parent, s.name, s.conflict, content);
      if (typeof placed === 'string') { json(409, { error: { code: placed } }); return true; }
      json(placed.created ? 201 : 200, this.json(placed.item));
      return true;
    }
    if (kind === 'graph-monitor' && req.method === 'GET') {
      const m = this.monitors.get(id ?? '');
      if (!m) { json(404, { error: { code: 'itemNotFound' } }); return true; }
      this.monitorPolls++;
      if (m.error) { json(200, { status: 'failed', error: { code: m.error } }); return true; }
      m.polls++;
      if (m.polls <= this.copyPollsBeforeDone) { json(202, { status: 'inProgress', percentageComplete: 50 }); return true; }
      json(200, { status: 'completed', percentageComplete: 100, resourceId: m.target });
      return true;
    }
    return false;
  }

  // Writes [start, end) of the content with backpressure, so a 1 GB generated file never sits in memory.
  private async stream(res: http.ServerResponse, c: Content, start: number, end: number) {
    if (c.kind === 'counted') throw new Error('fake graph keeps no bytes of a counted upload');
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
