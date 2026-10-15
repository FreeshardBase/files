import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { CollisionPolicy, Entry } from '@files/shared';
import { AppError } from '../../src/errors.ts';
import { RangeNotSatisfiable, type ByteRange, type StorageBackend, type WriteOptions } from '../../src/storage/backend.ts';
import type { OAuthClient, Provider } from '../../src/cloud/oauth.ts';
import { googleDriveProvider } from '../../src/cloud/googleDrive.ts';
import { dropboxProvider } from '../../src/cloud/dropbox.ts';
import { FakeDrive } from './fakeDrive.ts';
import { FakeDropbox } from './fakeDropbox.ts';
import { graphEndpoints, graphProviders } from '../../src/cloud/graph.ts';
import { FakeGraph, msHostOf } from './fakeGraph.ts';

// A fake cloud provider (spec §3.9): an OAuth 2 authorization server with a consent page, plus a small file API with the
// behaviour every real provider has and the backends must handle: pagination, 401 on an expired access token, rotated
// refresh tokens, 429 with Retry-After, resumable upload sessions and content served through a 302 to a pre-signed URL.
// The provider backends (#149–#151) extend it with each provider's own protocol subset: Google Drive's is `drive`
// (support/fakeDrive.ts), reached through `driveProvider()`; Dropbox's is `dropbox` (support/fakeDropbox.ts), reached
// through `dropboxProvider()`; Microsoft Graph's is `graph` (support/fakeGraph.ts), reached through `graphProviders()`.

/** `query` is the query string (or a session chunk's Content-Range), `body` a parsed JSON body or Dropbox-API-Arg. */
export type FakeRequest = { method: string; path: string; at: number; host?: string; token?: string; grant?: string; query?: string; body?: unknown };
type FakeFile = { type: 'file' | 'directory'; data: Buffer; modified: string };

export type FakeProviderOptions = {
  port?: number;
  /** The authorize endpoint requires an S256 challenge and the token endpoint checks the verifier. Default true. */
  pkce?: boolean;
  /** Every refresh issues a new refresh token and invalidates the old one. Default true. */
  rotateRefreshTokens?: boolean;
  /** Lifetime of an access token in seconds (`expires_in`). Default 3600. */
  accessTokenTtl?: number;
  /** Entries per list page. Default 2, so every listing paginates. */
  pageSize?: number;
};

/** The fake's accounts: id → e-mail. `testuser` is the one the consent page offers first. */
export const FAKE_ACCOUNTS: Record<string, string> = { 'acct-testuser': 'testuser@example.com', 'acct-member': 'member@example.com' };
export const FAKE_CLIENT = { id: 'files-fake', secret: 'fake-client-secret' };

export type FakeProvider = {
  url: string;
  /** The provider definition pointing at this server; its backend is `FakeCloudBackend`. */
  provider(o?: { id?: string; name?: string; pkce?: boolean }): Provider;
  /** The real Google Drive provider (`googleDriveProvider`) with this server's endpoints in place of Google's. */
  driveProvider(o?: { chunkBytes?: number }): Provider;
  /** The Drive v3 subset (support/fakeDrive.ts): its files, sessions and controls. */
  drive: FakeDrive;
  /** The real Dropbox provider (`dropboxProvider`) with this server's endpoints in place of Dropbox's. */
  dropboxProvider(o?: { chunkBytes?: number }): Provider;
  /** The Dropbox API v2 subset (support/fakeDropbox.ts): its items, sessions and controls. */
  dropbox: FakeDropbox;
  /** The real OneDrive and SharePoint providers (`graphProviders`) with this server's endpoints in place of Microsoft's. */
  graphProviders(o?: { chunkBytes?: number }): Provider[];
  /** The Microsoft Graph subset (support/fakeGraph.ts): drives, sites, sessions, monitors and controls. */
  graph: FakeGraph;
  /** Puts a file (or, with `null`, a folder) into the fake's store; parent folders are created. */
  put(path: string, content: string | Buffer | null): void;
  /** What the generic file API reports as the account's storage (`GET /api/quota`, #156); tests may change it. */
  quota: { used: number; total?: number };
  /** Every request in order. `token` is the bearer (API) or the refresh token (refresh grant). */
  requests: FakeRequest[];
  /** Called synchronously for every request before it is answered. */
  onRequest?: (r: FakeRequest) => void;
  /** Refresh grants answered with new tokens. */
  refreshGrants(): number;
  /** The refresh tokens the fake currently accepts. */
  validRefreshTokens(): string[];
  /** Every access token answers 401 from now on (as if it had expired). */
  expireAccessTokens(): void;
  /** Every refresh token is refused (`invalid_grant`), as after the member revoked the app at the provider. */
  revokeRefreshTokens(): void;
  /** Downloads of `path` in the generic file API send only the first half of its bytes (as a connection that drops). */
  truncateContent(path: string): void;
  /** The next `n` API requests answer `status` with `headers`, before the token is even looked at. */
  failNext(n: number, status: number, headers?: Record<string, string>): void;
  /** Submits the consent page for `authorizeUrl` like a browser would; answers where the fake sends the browser back. */
  consent(authorizeUrl: string, o?: { account?: string; deny?: boolean }): Promise<URL>;
  close(): Promise<void>;
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const b64url = (b: Buffer) => b.toString('base64url');
const tokenOf = () => b64url(randomBytes(24));
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const mimeOf = (name: string) => (name.endsWith('.txt') ? 'text/plain' : name.endsWith('.png') ? 'image/png' : 'application/octet-stream');

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function startFakeProvider(opts: FakeProviderOptions = {}): Promise<FakeProvider> {
  const pkce = opts.pkce ?? true;
  const rotate = opts.rotateRefreshTokens ?? true;
  const ttl = opts.accessTokenTtl ?? 3600;
  const pageSize = opts.pageSize ?? 2;
  const codes = new Map<string, { redirectUri: string; challenge?: string; account: string }>();
  const refreshTokens = new Map<string, string>(); // token → account
  const accessTokens = new Map<string, { account: string; expiresAt: number }>();
  const files = new Map<string, FakeFile>([['/', { type: 'directory', data: Buffer.alloc(0), modified: new Date().toISOString() }]]);
  const blobs = new Map<string, string>(); // pre-signed id → path
  const uploads = new Map<string, { path: string; size: number; parts: Buffer[]; received: number }>();
  const failures: { status: number; headers: Record<string, string> }[] = [];
  const truncated = new Set<string>();
  const requests: FakeRequest[] = [];
  let refreshGrants = 0;
  let url = '';
  const drive = new FakeDrive(() => url, pageSize);
  const dropbox = new FakeDropbox(pageSize);
  const graph = new FakeGraph(() => url, pageSize);

  const entry = (path: string, f: FakeFile): Entry => ({ name: nameOf(path) || '/', path, type: f.type, size: f.data.length,
    modified: f.modified, ...(f.type === 'file' ? { mime: mimeOf(nameOf(path)) } : {}) });
  const children = (dir: string) => [...files.entries()].filter(([p]) => p !== '/' && parentOf(p) === dir).sort(([a], [b]) => a.localeCompare(b));
  const put = (path: string, content: string | Buffer | null) => {
    for (let d = parentOf(path); !files.has(d); d = parentOf(d)) files.set(d, { type: 'directory', data: Buffer.alloc(0), modified: new Date().toISOString() });
    files.set(path, { type: content === null ? 'directory' : 'file', data: content === null ? Buffer.alloc(0) : Buffer.from(content),
      modified: new Date().toISOString() });
  };
  const issue = (account: string) => {
    const access = tokenOf(); const refresh = tokenOf();
    accessTokens.set(access, { account, expiresAt: Date.now() + ttl * 1000 });
    refreshTokens.set(refresh, account);
    return { access, refresh };
  };

  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));

  async function oauth(req: http.IncomingMessage, res: http.ServerResponse, u: URL, rec: FakeRequest) {
    if (u.pathname === '/oauth/authorize' && req.method === 'GET') {
      const q = u.searchParams;
      if (q.get('client_id') !== FAKE_CLIENT.id || q.get('response_type') !== 'code' || !q.get('redirect_uri') || !q.get('state')
          || (pkce && (!q.get('code_challenge') || q.get('code_challenge_method') !== 'S256'))) {
        return json(res, 400, { error: 'invalid_request' });
      }
      const hidden = ['redirect_uri', 'state', 'code_challenge'].filter((k) => q.get(k) !== null)
        .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(q.get(k)!)}">`).join('');
      const options = Object.entries(FAKE_ACCOUNTS).map(([id, mail]) => `<option value="${id}">${escapeHtml(mail)}</option>`).join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><head><title>Fake Cloud</title></head>
<body><main><h1>Fake Cloud</h1><p>FreeShard Files wants to access your files.</p>
<form method="post" action="/oauth/consent">${hidden}<label>Account <select name="account">${options}</select></label>
<button name="decision" value="allow">Allow</button> <button name="decision" value="deny">Deny</button></form></main></body></html>`);
      return;
    }
    if (u.pathname === '/oauth/consent' && req.method === 'POST') {
      const f = new URLSearchParams((await readBody(req)).toString());
      let back: URL;
      try { back = new URL(f.get('redirect_uri') ?? ''); } catch { return json(res, 400, { error: 'invalid_request' }); } // handled: malformed form
      back.searchParams.set('state', f.get('state') ?? '');
      if (f.get('decision') !== 'allow') back.searchParams.set('error', 'access_denied');
      else {
        const code = tokenOf();
        codes.set(code, { redirectUri: f.get('redirect_uri')!, account: f.get('account') ?? 'acct-testuser',
          ...(f.get('code_challenge') ? { challenge: f.get('code_challenge')! } : {}) });
        back.searchParams.set('code', code);
      }
      res.writeHead(302, { location: back.href }).end();
      return;
    }
    if (u.pathname === '/oauth/token' && req.method === 'POST') {
      const f = new URLSearchParams((await readBody(req)).toString());
      rec.grant = f.get('grant_type') ?? '';
      if (f.get('client_id') !== FAKE_CLIENT.id || f.get('client_secret') !== FAKE_CLIENT.secret) return json(res, 401, { error: 'invalid_client' });
      if (rec.grant === 'authorization_code') {
        const c = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? '');
        const verified = c?.challenge === undefined
          ? !pkce
          : b64url(createHash('sha256').update(f.get('code_verifier') ?? '').digest()) === c.challenge;
        if (!c || c.redirectUri !== f.get('redirect_uri') || !verified) return json(res, 400, { error: 'invalid_grant' });
        const t = issue(c.account);
        return json(res, 200, { access_token: t.access, refresh_token: t.refresh, token_type: 'Bearer', expires_in: ttl });
      }
      if (rec.grant === 'refresh_token') {
        const old = f.get('refresh_token') ?? '';
        rec.token = old;
        const account = refreshTokens.get(old);
        if (account === undefined) return json(res, 400, { error: 'invalid_grant' });
        refreshGrants++;
        const t = issue(account);
        if (rotate) refreshTokens.delete(old); else refreshTokens.delete(t.refresh);
        return json(res, 200, { access_token: t.access, token_type: 'Bearer', expires_in: ttl, ...(rotate ? { refresh_token: t.refresh } : {}) });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    return json(res, 404, { error: 'not_found' });
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, u: URL, rec: FakeRequest) {
    const fail = failures.shift();
    if (fail) return json(res, fail.status, { error: 'injected' }, fail.headers);
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    rec.token = token;
    const t = accessTokens.get(token);
    if (!t || t.expiresAt <= Date.now()) return json(res, 401, { error: 'invalid_token' });
    if (drive.thumbnail(req, res, u, rec)) return;
    if (await drive.api(req, res, u, rec, t.account, FAKE_ACCOUNTS[t.account]!)) return;
    if (await dropbox.api(req, res, u, rec, t.account, FAKE_ACCOUNTS[t.account]!)) return;
    if (await graph.api(req, res, u, rec, t.account, FAKE_ACCOUNTS[t.account]!)) return;
    const q = u.searchParams;
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)).toString() || '{}') as Record<string, string | number> : {};
    const at = (p: unknown) => (typeof p === 'string' ? files.get(p) : undefined);
    switch (`${req.method} ${u.pathname}`) {
      case 'GET /api/me': return json(res, 200, { id: t.account, email: FAKE_ACCOUNTS[t.account] });
      case 'GET /api/quota': return json(res, 200, fake.quota);
      case 'GET /api/list': {
        const dir = q.get('path') ?? '/';
        if (at(dir)?.type !== 'directory') return json(res, 404, { error: 'not_found' });
        const all = children(dir);
        const start = Number(q.get('cursor') ?? 0);
        const page = all.slice(start, start + pageSize).map(([p, f]) => entry(p, f));
        return json(res, 200, { entries: page, ...(start + pageSize < all.length ? { next: String(start + pageSize) } : {}) });
      }
      case 'GET /api/stat': {
        const f = at(q.get('path'));
        return f ? json(res, 200, entry(q.get('path')!, f)) : json(res, 404, { error: 'not_found' });
      }
      case 'GET /api/content': {
        const f = at(q.get('path'));
        if (f?.type !== 'file') return json(res, 404, { error: 'not_found' });
        const id = tokenOf();
        blobs.set(id, q.get('path')!);
        res.writeHead(302, { location: `${url}/blob/${id}` }).end();
        return;
      }
      case 'POST /api/mkdir': {
        if (files.has(String(body.path))) return json(res, 409, { error: 'exists' });
        if (at(parentOf(String(body.path)))?.type !== 'directory') return json(res, 404, { error: 'not_found' });
        put(String(body.path), null);
        return json(res, 201, entry(String(body.path), files.get(String(body.path))!));
      }
      case 'POST /api/delete': {
        const p = String(body.path);
        if (!files.has(p) || p === '/') return json(res, 404, { error: 'not_found' });
        for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k);
        res.writeHead(204).end();
        return;
      }
      case 'POST /api/move': case 'POST /api/copy': {
        const from = String(body.from); const to = String(body.to);
        if (!files.has(from) || from === '/') return json(res, 404, { error: 'not_found' });
        if (files.has(to)) return json(res, 409, { error: 'exists' });
        for (const [k, f] of [...files.entries()]) {
          if (k !== from && !k.startsWith(from + '/')) continue;
          files.set(to + k.slice(from.length), { ...f });
          if (u.pathname === '/api/move') files.delete(k);
        }
        return json(res, 200, entry(to, files.get(to)!));
      }
      case 'POST /api/uploads': {
        const id = tokenOf();
        uploads.set(id, { path: String(body.path), size: Number(body.size), parts: [], received: 0 });
        return json(res, 200, { uploadUrl: `${url}/upload/${id}` });
      }
    }
    return json(res, 404, { error: 'not_found' });
  }

  // Pre-signed URLs, like the providers': no bearer token, the URL itself is the capability.
  async function presigned(req: http.IncomingMessage, res: http.ServerResponse, u: URL, rec: FakeRequest) {
    if (await drive.presigned(req, res, u, rec)) return;
    if (await graph.presigned(req, res, u, rec)) return;
    const [, kind, id] = u.pathname.split('/');
    if (kind === 'blob' && req.method === 'GET') {
      const f = files.get(blobs.get(id ?? '') ?? '');
      if (!f) return json(res, 404, { error: 'not_found' });
      if (truncated.has(blobs.get(id!)!)) {
        const half = f.data.subarray(0, Math.floor(f.data.length / 2));
        return res.writeHead(200, { 'content-length': half.length }).end(half);
      }
      const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (!m) return res.writeHead(200, { 'content-length': f.data.length }).end(f.data);
      const start = Number(m[1]); const end = m[2] ? Math.min(Number(m[2]), f.data.length - 1) : f.data.length - 1;
      if (start >= f.data.length || start > end) return res.writeHead(416, { 'content-range': `bytes */${f.data.length}` }).end();
      res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${f.data.length}`, 'content-length': end - start + 1 })
        .end(f.data.subarray(start, end + 1));
      return;
    }
    if (kind === 'upload' && req.method === 'PUT') {
      const up = uploads.get(id ?? '');
      if (!up) return json(res, 404, { error: 'not_found' });
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range'] ?? ''));
      const chunk = await readBody(req);
      if (!m || Number(m[1]) !== up.received || Number(m[3]) !== up.size || Number(m[2]) - Number(m[1]) + 1 !== chunk.length) {
        return json(res, 416, { error: 'bad_range', next: up.received });
      }
      up.parts.push(chunk); up.received += chunk.length;
      if (up.received < up.size) return json(res, 202, { next: up.received });
      uploads.delete(id!);
      put(up.path, Buffer.concat(up.parts));
      return json(res, 201, entry(up.path, files.get(up.path)!));
    }
    return json(res, 404, { error: 'not_found' });
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', url);
    const rec: FakeRequest = { method: req.method ?? 'GET', path: u.pathname, at: Date.now() };
    // Drive's API needs the bearer token, and so do its thumbnailLinks (Drive: a file not shared publicly needs a
    // credentialed request); its upload session URIs (`upload_id`) and the thumbnail `/feeds/vt` redirects to are
    // pre-signed, like Google's. Every
    // Dropbox endpoint needs the bearer token, content ones included. Graph's API needs it; its download, upload-session
    // and copy-monitor URLs are pre-signed.
    const driveApi = u.pathname.startsWith('/drive/') || u.pathname.startsWith('/dropbox/') || u.pathname.startsWith('/graph/')
      || (u.pathname.startsWith('/upload/drive/') && !u.searchParams.has('upload_id'))
      || u.pathname.startsWith('/drive-thumb/') || u.pathname === '/feeds/vt';
    const handle = u.pathname.startsWith('/oauth/') ? oauth : u.pathname.startsWith('/api/') || driveApi ? api : presigned;
    // Recorded on arrival, so a hook sees the state the request was sent in (`token`/`grant` are filled in while handling).
    requests.push(rec);
    fake.onRequest?.(rec);
    handle(req, res, u, rec).then(() => undefined, (err: unknown) => {
      // handled: a broken request in a test answers 500 instead of crashing the fake
      json(res, 500, { error: String(err) });
    });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const fake: FakeProvider = {
    url, requests, put, quota: { used: 2_500_000, total: 15_000_000_000 },
    provider: (o = {}) => ({
      id: o.id ?? 'fake', name: o.name ?? 'Fake Cloud', authorizationEndpoint: `${url}/oauth/authorize`, tokenEndpoint: `${url}/oauth/token`,
      clientId: FAKE_CLIENT.id, clientSecret: FAKE_CLIENT.secret, scopes: ['files.readwrite', 'offline_access'], pkce: o.pkce ?? pkce,
      async account(client) {
        const r = await client.fetch(`${url}/api/me`);
        if (!r.ok) throw new Error(`fake /api/me answered ${r.status}`);
        const me = await r.json() as { id: string; email: string };
        return { id: me.id, label: me.email };
      },
      backend: (client) => new FakeCloudBackend(url, client),
    }),
    driveProvider: (o = {}) => googleDriveProvider({ clientId: FAKE_CLIENT.id, clientSecret: FAKE_CLIENT.secret }, {
      endpoints: { authorization: `${url}/oauth/authorize`, token: `${url}/oauth/token`, api: `${url}/drive/v3`,
        upload: `${url}/upload/drive/v3`, contentHost: (h) => h.origin === url, thumbnailHost: (h) => h.origin === url },
      ...(o.chunkBytes !== undefined ? { chunkBytes: o.chunkBytes } : {}),
    }),
    drive,
    dropboxProvider: (o = {}) => dropboxProvider({ clientId: FAKE_CLIENT.id, clientSecret: FAKE_CLIENT.secret }, {
      endpoints: { authorization: `${url}/oauth/authorize`, token: `${url}/oauth/token`, api: `${url}/dropbox/api/2`,
        content: `${url}/dropbox/content/2` },
      ...(o.chunkBytes !== undefined ? { chunkBytes: o.chunkBytes } : {}),
    }),
    dropbox,
    graphProviders: (o = {}) => graphProviders({ clientId: FAKE_CLIENT.id, clientSecret: FAKE_CLIENT.secret, tenant: 'common' }, {
      // A pre-signed URL is on the fake's origin, tagged with the Microsoft host it stands for (support/fakeGraph.ts);
      // that host must pass the production allowlist.
      endpoints: { authorization: `${url}/oauth/authorize`, token: `${url}/oauth/token`, api: `${url}/graph/v1.0`,
        contentHost: (h) => {
          const ms = msHostOf(h.pathname);
          return h.origin === url && ms !== null && graphEndpoints('common').contentHost(new URL(`https://${ms.host}/`));
        } },
      ...(o.chunkBytes !== undefined ? { chunkBytes: o.chunkBytes } : {}),
    }),
    graph,
    refreshGrants: () => refreshGrants,
    validRefreshTokens: () => [...refreshTokens.keys()],
    expireAccessTokens: () => accessTokens.clear(),
    revokeRefreshTokens: () => refreshTokens.clear(),
    truncateContent: (path) => { truncated.add(path); },
    failNext: (n, status, headers = {}) => { for (let i = 0; i < n; i++) failures.push({ status, headers }); },
    async consent(authorizeUrl, o = {}) {
      const page = await fetch(authorizeUrl);
      if (!page.ok) throw new Error(`consent page answered ${page.status}`);
      await page.text();
      const q = new URL(authorizeUrl).searchParams;
      const form = new URLSearchParams({ redirect_uri: q.get('redirect_uri')!, state: q.get('state')!,
        account: o.account ?? 'acct-testuser', decision: o.deny ? 'deny' : 'allow',
        ...(q.get('code_challenge') ? { code_challenge: q.get('code_challenge')! } : {}) });
      const r = await fetch(`${url}/oauth/consent`, { method: 'POST', body: form, redirect: 'manual' });
      return new URL(r.headers.get('location')!);
    },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
  return fake;
}

/** Bytes per upload-session chunk; small, so tests see several chunks. */
const CHUNK = 64 * 1024;

/** A `StorageBackend` over the fake's file API; every request goes through the connection's OAuthClient. */
export class FakeCloudBackend implements StorageBackend {
  constructor(private base: string, private client: OAuthClient) {}

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await this.client.fetch(`${this.base}${path}`, { method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
    if (res.status === 404) { await res.body?.cancel(); throw new AppError('NOT_FOUND'); }
    if (res.status === 409) { await res.body?.cancel(); throw new AppError('FILE_EXISTS'); }
    if (!res.ok) { await res.body?.cancel(); throw new Error(`fake ${method} ${path} answered ${res.status}`); }
    return res;
  }

  /** Follows the pagination to the end. */
  async list(path: string) {
    const entries: Entry[] = [];
    let cursor: string | undefined;
    do {
      const r = await (await this.call('GET', `/api/list?${new URLSearchParams({ path, ...(cursor ? { cursor } : {}) })}`)).json() as { entries: Entry[]; next?: string };
      entries.push(...r.entries);
      cursor = r.next;
    } while (cursor);
    return { entries };
  }
  async stat(path: string): Promise<Entry> { return (await this.call('GET', `/api/stat?${new URLSearchParams({ path })}`)).json() as Promise<Entry>; }
  async quota(): Promise<{ used: number; total?: number }> {
    return (await this.call('GET', '/api/quota')).json() as Promise<{ used: number; total?: number }>;
  }

  async read(path: string, range?: ByteRange | ((size: number) => ByteRange | undefined)) {
    const entry = await this.stat(path);
    const r = typeof range === 'function' ? range(entry.size) : range;
    // The fake answers with a 302 to a pre-signed URL; fetch follows it.
    const res = await this.client.fetch(`${this.base}/api/content?${new URLSearchParams({ path })}`,
      r ? { headers: { range: `bytes=${r.start}-${r.end}` } } : {});
    if (res.status === 416) { await res.body?.cancel(); throw new RangeNotSatisfiable(entry.size); }
    if (!res.ok || !res.body) { await res.body?.cancel(); throw new Error(`fake content answered ${res.status}`); }
    return { entry, stream: Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), etag: `"${entry.size}-${entry.modified}"`,
      ...(r ? { range: r } : {}) };
  }

  /** An upload session: the body goes in chunks to the session's pre-signed URL, without the bearer token. */
  async write(path: string, body: Readable, opts: WriteOptions): Promise<Entry> {
    if (opts.size === undefined) throw new AppError('VALIDATION');
    const existing = await this.stat(path).then((e) => e, (e: unknown) => { if (e instanceof AppError && e.code === 'NOT_FOUND') return null; throw e; });
    if (existing && opts.onCollision === 'fail') throw new AppError('FILE_EXISTS', { name: existing.name });
    const target = existing && opts.onCollision === 'keep-both' ? path.replace(/(\.[^./]*)?$/, ' (1)$1') : path;
    const { uploadUrl } = await (await this.call('POST', '/api/uploads', { path: target, size: opts.size })).json() as { uploadUrl: string };
    let pending: Buffer[] = []; let pendingBytes = 0; let offset = 0; let last: Response | undefined;
    const flush = async () => {
      const chunk = Buffer.concat(pending); pending = []; pendingBytes = 0;
      last = await fetch(uploadUrl, { method: 'PUT', body: chunk,
        headers: { 'content-range': `bytes ${offset}-${offset + chunk.length - 1}/${opts.size}` } });
      offset += chunk.length;
      if (last.status !== 201 && last.status !== 202) throw new AppError('SIZE_MISMATCH');
    };
    for await (const c of body) {
      pending.push(c as Buffer); pendingBytes += (c as Buffer).length;
      if (pendingBytes >= CHUNK) { await last?.body?.cancel(); await flush(); }
    }
    if (pendingBytes > 0 || opts.size === 0) { await last?.body?.cancel(); await flush(); }
    if (last?.status !== 201) throw new AppError('SIZE_MISMATCH');
    return last.json() as Promise<Entry>;
  }

  async mkdir(path: string): Promise<Entry> { return (await this.call('POST', '/api/mkdir', { path })).json() as Promise<Entry>; }
  async move(from: string, to: string, _onCollision: CollisionPolicy): Promise<Entry> {
    return (await this.call('POST', '/api/move', { from, to })).json() as Promise<Entry>;
  }
  async copy(from: string, to: string, _onCollision: CollisionPolicy): Promise<Entry> {
    return (await this.call('POST', '/api/copy', { from, to })).json() as Promise<Entry>;
  }
  async delete(paths: readonly string[]): Promise<void> {
    for (const path of paths) await (await this.call('POST', '/api/delete', { path })).body?.cancel();
  }
}
