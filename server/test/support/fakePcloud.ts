import type http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { FakeRequest } from './fakeProvider.ts';
import { generatedByte } from './fakeDrive.ts';

// The pCloud API subset that PcloudBackend uses (#211), mounted on the fake provider (spec §3.9), as docs.pcloud.com
// describes it:
// - `/pcloud/oauth2/authorize` stands for `my.pcloud.com/oauth2/authorize`. The consent sends the browser back with
//   `code`, `state`, `locationid` and `hostname`, the API host of the account's region (`api.pcloud.com` for the US,
//   `eapi.pcloud.com` for the EU).
// - `/pcloud/<api host>/<method>` stands for `https://<api host>/<method>`. Parameters come in the query string or a
//   form body. Every answer is HTTP 200 with JSON whose `result` is 0 or an error code with `error` (the message), the
//   way pCloud reports every failure, a bad token included. `oauth2_token` trades a code for an access token that
//   never expires and comes without a refresh token. Every other method needs the token (`Authorization: Bearer` or
//   `access_token`), and only on the API host of its account's region.
// - `/pcloud-content/<content host>/<link path>` stands for `https://<content host><link path>`, the download link
//   `getfilelink` hands out. It needs no token and honours Range; a token arriving there is recorded (`rec.token`).
// Paths are case-sensitive. Folders list whole (`listfolder` has no paging). Deletes go to pCloud's trash. A file keeps
// its earlier contents as revisions. `hash` is pCloud's 64-bit number, which JSON carries beyond 2^53.

/** Uploads above this are counted and hashed, not kept: the bounded-memory test must not fill the fake's memory. */
const KEEP_UPLOAD_BYTES = 16 * 1024 * 1024;
const BLOCK = Buffer.from(Array.from({ length: 65536 }, (_, i) => generatedByte(i)));

type Content = { kind: 'bytes'; data: Buffer } | { kind: 'generated'; size: number } | { kind: 'counted'; size: number; md5: string };
export type PcloudRevision = { revisionid: number; size: number; hash: string; created: string; content: Content };
export type PcloudItem = { id: number; name: string; path: string; folder: boolean; content?: Content; hash: string;
  created: string; modified: string; thumb: boolean; revisions: PcloudRevision[] };
type Upload = { account: string; size: number; parts: Buffer[]; md5: ReturnType<typeof createHash> };

/** The fake's pCloud accounts: the region decides the API host its token works on. */
export const PCLOUD_ACCOUNTS: Record<string, { uid: number; email: string; region: 'us' | 'eu' }> = {
  'acct-testuser': { uid: 1001, email: 'testuser@example.com', region: 'us' },
  'acct-member': { uid: 1002, email: 'member@example.com', region: 'eu' },
};
const REGIONS = { us: { hostname: 'api.pcloud.com', locationid: 1, content: 'c123.pcloud.com' },
  eu: { hostname: 'eapi.pcloud.com', locationid: 2, content: 'e456.pcloud.com' } } as const;
export const PCLOUD_CLIENT = { id: 'files-fake', secret: 'fake-client-secret' };

/** pCloud's error codes the fake answers (docs.pcloud.com, "Errors" of each method). */
export const PCLOUD_ERRORS = {
  1000: 'Log in required.',
  1002: 'No full path or folderid provided.',
  1004: 'No fileid or path provided.',
  1022: 'Please provide \'revisionid\'.',
  2001: 'Invalid file/folder name.',
  2002: 'A component of parent directory does not exist.',
  2004: 'File or folder alredy exists.',
  2005: 'Directory does not exist.',
  2007: 'Invalid upload id.',
  2008: 'User is over quota.',
  2009: 'File not found.',
  2012: 'Invalid \'code\' provided.',
  2043: 'Can not move a folder to a subfolder of itself.',
  2060: 'Invalid revisionid.',
  2094: 'Invalid \'access_token\' provided.',
} as const;
type ErrorCode = keyof typeof PCLOUD_ERRORS;

const sizeOf = (c?: Content) => (c === undefined ? 0 : c.kind === 'bytes' ? c.data.length : c.size);
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
/** pCloud's default time format: RFC 2822, as `Thu, 21 Mar 2013 18:31:42 +0000`. */
const rfc2822 = (d: Date) => d.toUTCString().replace('GMT', '+0000');
/** A 64-bit hash as pCloud's JSON carries it: a bare number, often beyond 2^53. */
const hash64 = (c?: Content) => {
  const seed = c?.kind === 'bytes' ? c.data : Buffer.from(randomBytes(16));
  return BigInt.asUintN(64, createHash('sha256').update(seed).digest().readBigUInt64BE(0) | (1n << 63n)).toString();
};
const json = (res: http.ServerResponse, body: Record<string, unknown>): void => {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    // `hash` is a bare 64-bit number in pCloud's JSON; JSON.stringify could only write it as a string.
    .end(JSON.stringify(body).replace(/"hash":"(\d+)"/g, '"hash":$1'));
};
const error = (res: http.ServerResponse, code: ErrorCode): void => json(res, { result: code, error: PCLOUD_ERRORS[code] });

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export class FakePcloud {
  /** Items by path; the root is folder 0. */
  readonly items = new Map<string, PcloudItem>();
  /** Items deleted into pCloud's trash. */
  readonly trash: PcloudItem[] = [];
  /** Upload requests in order: `create`, `write <offset>+n`, `save <path>`, `delete`. */
  readonly uploadLog: string[] = [];
  /** What `userinfo` reports. */
  quota = { usedquota: 52_428_800, quota: 10 * 1024 ** 3 };
  /** Overrides the content hosts `getfilelink` names (a test of the allowlist). */
  linkHosts: string[] | undefined;
  private nextId = 1;
  private codes = new Map<string, { account: string; redirectUri: string }>();
  private tokens = new Map<string, string>(); // access token → account
  private links = new Map<string, Content>(); // link id → content at the time of getfilelink
  private uploads = new Map<number, Upload>();
  private nextUpload = 7001;
  private nextRevision = 900;

  constructor() {
    const at = rfc2822(new Date());
    this.items.set('/', { id: 0, name: '/', path: '/', folder: true, hash: '0', created: at, modified: at, thumb: false, revisions: [] });
  }

  /** Adds a file (string/Buffer, `{ generated: n }` for n pattern bytes, `null` for a folder), creating parent folders. */
  put(path: string, content: string | Buffer | null | { generated: number }, o: { thumbnail?: boolean } = {}): PcloudItem {
    for (const dir of this.ancestors(path)) if (!this.items.has(dir)) this.create(dir, undefined);
    const c: Content | undefined = content === null ? undefined : typeof content === 'object' && !Buffer.isBuffer(content)
      ? { kind: 'generated', size: content.generated } : { kind: 'bytes', data: Buffer.from(content) };
    const item = this.create(path, c);
    item.thumb = o.thumbnail ?? false;
    return item;
  }

  /** Content of a kept file (tests compare it). */
  bytes(path: string): Buffer {
    const c = this.items.get(path)?.content;
    if (c?.kind !== 'bytes') throw new Error(`fake pcloud file ${path} has no kept bytes`);
    return c.data;
  }
  md5(path: string): string | undefined {
    const c = this.items.get(path)?.content;
    return c?.kind === 'bytes' ? createHash('md5').update(c.data).digest('hex') : c?.kind === 'counted' ? c.md5 : undefined;
  }

  /** Every access token is refused from now on (`2094`), as after the member removed the app at pCloud. */
  revokeTokens(): void { this.tokens.clear(); }

  private ancestors(path: string): string[] {
    const out: string[] = [];
    for (let d = parentOf(path); d !== '/'; d = parentOf(d)) out.unshift(d);
    return out;
  }

  private create(path: string, content: Content | undefined): PcloudItem {
    const at = rfc2822(new Date());
    const item: PcloudItem = { id: this.nextId++, name: nameOf(path), path, folder: content === undefined, hash: hash64(content),
      created: at, modified: at, thumb: false, revisions: [], ...(content ? { content } : {}) };
    this.items.set(path, item);
    return item;
  }

  /** A new content for a file: the old one becomes a revision, as at pCloud. */
  private replaceContent(item: PcloudItem, content: Content) {
    item.revisions.push({ revisionid: this.nextRevision++, size: sizeOf(item.content), hash: item.hash, created: item.modified,
      content: item.content! });
    item.content = content;
    item.hash = hash64(content);
    item.modified = rfc2822(new Date(Date.now() + 1000 * item.revisions.length));
  }

  private metadata(i: PcloudItem, withContents = false): Record<string, unknown> {
    const base = { name: i.name, path: i.path, created: i.created, modified: i.modified, isfolder: i.folder, ismine: true, isshared: false,
      parentfolderid: i.path === '/' ? undefined : this.items.get(parentOf(i.path))?.id, icon: i.folder ? 'folder' : 'document' };
    if (i.folder) {
      return { ...base, id: `d${i.id}`, folderid: i.id, thumb: false,
        ...(withContents ? { contents: this.childrenOf(i.path).map((c) => this.metadata(c)) } : {}) };
    }
    return { ...base, id: `f${i.id}`, fileid: i.id, size: sizeOf(i.content), hash: i.hash, category: i.thumb ? 1 : 4,
      contenttype: i.name.endsWith('.png') ? 'image/png' : i.name.endsWith('.txt') ? 'text/plain' : 'application/octet-stream', thumb: i.thumb };
  }

  private childrenOf(dir: string) {
    return [...this.items.values()].filter((i) => i.path !== '/' && parentOf(i.path) === dir).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Moves or copies the item at `from` (and everything beneath it) to `to`. */
  private relocate(from: PcloudItem, to: string, keep: boolean): PcloudItem {
    const fp = from.path; // `from` itself is moved on the way
    for (const [k, i] of [...this.items.entries()]) {
      if (k !== fp && !k.startsWith(`${fp}/`)) continue;
      const path = to + i.path.slice(fp.length);
      if (!keep) this.items.delete(k);
      const moved: PcloudItem = keep ? { ...i, id: this.nextId++, revisions: [] } : i;
      moved.path = path; moved.name = nameOf(path);
      this.items.set(path, moved);
    }
    return this.items.get(to)!;
  }

  private remove(i: PcloudItem) {
    this.trash.push(i);
    for (const k of [...this.items.keys()]) if (k === i.path || k.startsWith(`${i.path}/`)) this.items.delete(k);
  }

  /** The consent page and its form. Answers false when the path is not pCloud's authorization server. */
  async oauth(req: http.IncomingMessage, res: http.ServerResponse, u: URL): Promise<boolean> {
    if (u.pathname === '/pcloud/oauth2/authorize' && req.method === 'GET') {
      const q = u.searchParams;
      if (q.get('client_id') !== PCLOUD_CLIENT.id || q.get('response_type') !== 'code' || !q.get('redirect_uri')) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Invalid request');
        return true;
      }
      const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      const hidden = ['redirect_uri', 'state'].filter((k) => q.get(k) !== null)
        .map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k)!)}">`).join('');
      const options = Object.entries(PCLOUD_ACCOUNTS).map(([id, a]) => `<option value="${id}">${esc(a.email)}</option>`).join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><head><title>Fake pCloud</title></head>
<body><main><h1>Fake pCloud</h1><p>FreeShard Files wants to access your pCloud.</p>
<form method="post" action="/pcloud/oauth2/consent">${hidden}<label>Account <select name="account">${options}</select></label>
<button name="decision" value="allow">Allow</button> <button name="decision" value="deny">Deny</button></form></main></body></html>`);
      return true;
    }
    if (u.pathname === '/pcloud/oauth2/consent' && req.method === 'POST') {
      const f = new URLSearchParams((await readBody(req)).toString());
      const back = new URL(f.get('redirect_uri') ?? '');
      if (f.get('state') !== null) back.searchParams.set('state', f.get('state')!);
      const account = f.get('account') ?? 'acct-testuser';
      const region = REGIONS[PCLOUD_ACCOUNTS[account]!.region];
      if (f.get('decision') !== 'allow') back.searchParams.set('error', 'access_denied');
      else {
        const code = randomBytes(18).toString('base64url');
        this.codes.set(code, { account, redirectUri: f.get('redirect_uri')! });
        back.searchParams.set('code', code);
        back.searchParams.set('locationid', String(region.locationid));
        back.searchParams.set('hostname', region.hostname);
      }
      res.writeHead(302, { location: back.href }).end();
      return true;
    }
    return false;
  }

  /** `/pcloud/<api host>/<method>`. Answers false when the path is not pCloud's API. */
  async api(req: http.IncomingMessage, res: http.ServerResponse, u: URL, rec: FakeRequest): Promise<boolean> {
    const m = /^\/pcloud\/(api\.pcloud\.com|eapi\.pcloud\.com)\/([a-z_0-9]+)$/.exec(u.pathname);
    if (!m) return false;
    const host = m[1]!; const method = m[2]!;
    rec.host = host;
    const q = new URLSearchParams(u.search);
    const form = method !== 'upload_write' && /application\/x-www-form-urlencoded/.test(String(req.headers['content-type'] ?? ''));
    const raw = await readBody(req);
    if (form) for (const [k, v] of new URLSearchParams(raw.toString())) q.append(k, v);
    rec.body = Object.fromEntries([...q].filter(([k]) => k !== 'access_token' && k !== 'client_secret'));
    rec.query = method;

    if (method === 'oauth2_token') {
      const c = this.codes.get(q.get('code') ?? '');
      if (q.get('client_id') !== PCLOUD_CLIENT.id || q.get('client_secret') !== PCLOUD_CLIENT.secret || !c
        || REGIONS[PCLOUD_ACCOUNTS[c.account]!.region].hostname !== host) return error(res, 2012), true;
      this.codes.delete(q.get('code')!);
      const token = randomBytes(30).toString('base64url');
      this.tokens.set(token, c.account);
      const a = PCLOUD_ACCOUNTS[c.account]!;
      return json(res, { result: 0, access_token: token, token_type: 'bearer', uid: a.uid, locationid: REGIONS[a.region].locationid }), true;
    }

    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? q.get('access_token') ?? undefined;
    rec.token = bearer;
    if (bearer === undefined) return error(res, 1000), true;
    const account = this.tokens.get(bearer);
    if (account === undefined || REGIONS[PCLOUD_ACCOUNTS[account]!.region].hostname !== host) return error(res, 2094), true;
    await this.method(method, q, raw, res, account);
    return true;
  }

  private async method(method: string, q: URLSearchParams, raw: Buffer, res: http.ServerResponse, account: string): Promise<void> {
    const path = q.get('path') ?? undefined;
    const at = (p: string | undefined) => (p === undefined ? undefined : this.items.get(p));
    const valid = (p: string | undefined) => p !== undefined && p.startsWith('/') && !p.split('/').slice(1).some((s) => s === '' && p !== '/');
    const a = PCLOUD_ACCOUNTS[account]!;
    switch (method) {
      case 'userinfo':
        return json(res, { result: 0, userid: a.uid, email: a.email, emailverified: true, premium: false, ...this.quota });
      case 'listfolder': {
        if (q.get('folderid') === null && path === undefined) return error(res, 1002);
        const f = q.get('folderid') !== null ? [...this.items.values()].find((i) => i.folder && i.id === Number(q.get('folderid'))) : at(path);
        if (!f?.folder) return error(res, 2005);
        const meta = this.metadata(f, true);
        if (q.get('nofiles') === '1') meta.contents = (meta.contents as { isfolder: boolean }[]).filter((c) => c.isfolder);
        return json(res, { result: 0, metadata: meta });
      }
      case 'stat': {
        if (path === undefined) return error(res, 1004);
        const f = at(path);
        if (!f || f.folder) return error(res, 2009);
        return json(res, { result: 0, metadata: this.metadata(f) });
      }
      case 'getfilelink': {
        const f = at(path);
        if (path === undefined) return error(res, 1004);
        if (!f || f.folder) return error(res, 2009);
        const id = randomBytes(12).toString('base64url');
        this.links.set(id, f.content!);
        return json(res, { result: 0, path: `/D${id}/${encodeURIComponent(f.name)}`, expires: rfc2822(new Date(Date.now() + 3_600_000)),
          hosts: this.linkHosts ?? [REGIONS[a.region].content, 'p-def1.pcloud.com'] });
      }
      case 'getthumb': {
        const f = at(path);
        if (!f || f.folder) return error(res, 2009);
        const size = /^(\d+)x(\d+)$/.exec(q.get('size') ?? '');
        if (!f.thumb || !size || f.content?.kind !== 'bytes') return json(res, { result: 2009, error: 'File not found.' });
        const sharp = (await import('sharp')).default;
        const png = await sharp(f.content.data).resize(Number(size[1]), Number(size[2]), { fit: 'inside' }).png().toBuffer();
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length }).end(png);
        return;
      }
      case 'createfolder': {
        if (!valid(path)) return error(res, 2001);
        if (at(path)) return error(res, 2004);
        if (!at(parentOf(path!))?.folder) return error(res, 2002);
        return json(res, { result: 0, metadata: this.metadata(this.create(path!, undefined)) });
      }
      case 'renamefile': case 'renamefolder': case 'copyfile': {
        const f = at(path);
        if (!f || f.folder !== (method === 'renamefolder')) return error(res, method === 'renamefolder' ? 2005 : 2009);
        const to = q.get('topath') ?? undefined;
        if (!valid(to)) return error(res, 2001);
        if (!at(parentOf(to!))?.folder) return error(res, 2002);
        if (method === 'renamefolder' && (to === f.path || to!.startsWith(`${f.path}/`))) return error(res, 2043);
        const there = at(to);
        if (there && (there.folder || method === 'renamefolder' || q.get('noover') === '1')) return error(res, 2004);
        if (there) this.items.delete(there.path); // a file at the target is overwritten
        return json(res, { result: 0, metadata: this.metadata(this.relocate(f, to!, method === 'copyfile')) });
      }
      case 'copyfolder': {
        const f = at(path);
        if (!f?.folder) return error(res, 2005);
        const dest = [...this.items.values()].find((i) => i.folder && i.id === Number(q.get('tofolderid')));
        if (!dest) return error(res, 2005);
        if (dest.path === f.path || dest.path.startsWith(`${f.path}/`)) return error(res, 2043);
        const into = q.get('copycontentonly') === '1' ? dest.path : join(dest.path, f.name);
        if (q.get('copycontentonly') !== '1') {
          if (at(into)) return error(res, 2004);
          this.relocate(f, into, true);
        } else {
          for (const c of this.childrenOf(f.path)) {
            if (at(join(into, c.name)) && q.get('noover') === '1') return error(res, 2004);
          }
          for (const c of this.childrenOf(f.path)) this.relocate(c, join(into, c.name), true);
        }
        return json(res, { result: 0, metadata: this.metadata(this.items.get(into)!) });
      }
      case 'deletefile': {
        const f = at(path);
        if (!f || f.folder) return error(res, 2009);
        this.remove(f);
        return json(res, { result: 0, metadata: { ...this.metadata(f), isdeleted: true } });
      }
      case 'deletefolderrecursive': {
        const f = at(path);
        if (!f?.folder || f.path === '/') return error(res, 2005);
        const inside = [...this.items.values()].filter((i) => i.path.startsWith(`${f.path}/`));
        this.remove(f);
        return json(res, { result: 0, deletedfiles: inside.filter((i) => !i.folder).length, deletedfolders: inside.filter((i) => i.folder).length + 1 });
      }
      case 'upload_create': {
        const id = this.nextUpload++;
        this.uploads.set(id, { account, size: 0, parts: [], md5: createHash('md5') });
        this.uploadLog.push('create');
        return json(res, { result: 0, uploadid: id });
      }
      case 'upload_write': {
        const up = this.uploads.get(Number(q.get('uploadid')));
        if (!up || up.account !== account) return error(res, 2007);
        if (Number(q.get('uploadoffset')) !== up.size) return json(res, { result: 2068, error: 'Invalid upload offset.' }); // docs: offset must follow
        this.uploadLog.push(`write ${up.size}+${raw.length}`);
        up.md5.update(raw);
        if (up.size + raw.length <= KEEP_UPLOAD_BYTES) up.parts.push(raw);
        else up.parts = [];
        up.size += raw.length;
        return json(res, { result: 0 });
      }
      case 'upload_save': {
        const id = Number(q.get('uploadid'));
        const up = this.uploads.get(id);
        if (!up || up.account !== account) return error(res, 2007);
        const name = q.get('name') ?? '';
        if (!name || name.includes('/')) return error(res, 2001);
        const dir = at(path);
        if (!dir?.folder) return error(res, 2005);
        const target = join(dir.path, name);
        const there = at(target);
        if (there?.folder) return error(res, 2004);
        this.uploads.delete(id);
        this.uploadLog.push(`save ${target}`);
        const content: Content = up.size <= KEEP_UPLOAD_BYTES ? { kind: 'bytes', data: Buffer.concat(up.parts) }
          : { kind: 'counted', size: up.size, md5: up.md5.digest('hex') };
        let item: PcloudItem;
        if (there) { this.replaceContent(there, content); item = there; } // an existing file gets a new revision
        else item = this.create(target, content);
        return json(res, { result: 0, metadata: this.metadata(item) });
      }
      case 'upload_delete': {
        if (!this.uploads.delete(Number(q.get('uploadid')))) return error(res, 2007);
        this.uploadLog.push('delete');
        return json(res, { result: 0 });
      }
      case 'listrevisions': {
        const f = at(path);
        if (!f || f.folder) return error(res, 2009);
        return json(res, { result: 0, metadata: this.metadata(f),
          revisions: [...f.revisions].reverse().map((r) => ({ revisionid: r.revisionid, size: r.size, hash: r.hash, created: r.created })) });
      }
      case 'revertrevision': {
        const f = at(path);
        if (!f || f.folder) return error(res, 2009);
        if (q.get('revisionid') === null) return error(res, 1022);
        const r = f.revisions.find((x) => x.revisionid === Number(q.get('revisionid')));
        if (!r) return error(res, 2060);
        this.replaceContent(f, r.content);
        return json(res, { result: 0, metadata: this.metadata(f) });
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: 2000, error: 'Invalid method.' }));
  }

  /** `/pcloud-content/<host>/<link path>`: a download link, no token needed. Answers false for other paths. */
  content(req: http.IncomingMessage, res: http.ServerResponse, u: URL, rec: FakeRequest): boolean {
    const m = /^\/pcloud-content\/([a-z0-9.-]+)\/D([A-Za-z0-9_-]+)\/[^/]+$/.exec(u.pathname);
    if (!m) return false;
    rec.host = m[1];
    if (req.headers.authorization !== undefined) rec.token = String(req.headers.authorization);
    const c = this.links.get(m[2]!);
    if (!c || req.method !== 'GET') { res.writeHead(404).end(); return true; }
    const size = sizeOf(c);
    const r = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
    const [start, end] = r ? [Number(r[1]), r[2] ? Math.min(Number(r[2]), size - 1) : size - 1] : [0, size - 1];
    if (r && (start >= size || start > end)) { res.writeHead(416, { 'content-range': `bytes */${size}` }).end(); return true; }
    res.writeHead(r ? 206 : 200, { 'content-type': 'application/octet-stream', 'content-length': Math.max(0, end - start + 1),
      ...(r ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
    if (c.kind === 'bytes') { res.end(c.data.subarray(start, end + 1)); return true; }
    if (c.kind === 'counted') { res.destroy(); return true; }
    // Generated content in 64 KiB blocks, with backpressure, so a 1 GB download never sits in memory.
    let at = start;
    const pump = () => {
      while (at <= end) {
        const off = at % BLOCK.length;
        const chunk = BLOCK.subarray(off, Math.min(BLOCK.length, off + end - at + 1));
        at += chunk.length;
        if (!res.write(chunk)) { res.once('drain', pump); return; }
      }
      res.end();
    };
    pump();
    return true;
  }
}
