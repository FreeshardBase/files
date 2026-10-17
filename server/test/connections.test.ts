import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { Connection, ConnectionList } from '@files/shared';
import { open } from '../src/cloud/secretBox.ts';
import { MAX_JITTER_MS, MAX_RETRIES, type Clock } from '../src/cloud/oauth.ts';
import { startTestApp, login, type TestApp } from './support/harness.ts';
import { startFakeProvider, type FakeProvider } from './support/fakeProvider.ts';

// #148: cloud connections. Members connect their own accounts through the provider's consent page (here the fake
// provider's), the refresh token is stored sealed and rotated, the OAuthClient refreshes once for many requests and backs
// off on 429/5xx, and only the owner can see, use or unlink a connection. Absorbs #41, #58, #74 and #106.

type S = { cookie: string; csrf: string; id: string };
const ORIGIN = 'https://files.example.com';
const CALLBACK = `${ORIGIN}/api/v1/connections/callback`;

let t: TestApp; let fake: FakeProvider; let a: S; let b: S;
const logLines: string[] = [];
const logStream = new Writable({ write(chunk, _enc, cb) { logLines.push(String(chunk)); cb(); } });

// A fake clock: `advance` moves time on (expiring access tokens on the client side), `sleep` records each wait and
// moves time on by it instead of waiting, and jitter is the maximum, so a wait is checked at its upper bound too.
let offset = 0;
const sleeps: { ms: number; requestsBefore: number }[] = [];
const clock: Clock & { sleeps: typeof sleeps; advance(ms: number): void } = {
  sleeps,
  now: () => Date.now() + offset,
  sleep: async (ms) => { sleeps.push({ ms, requestsBefore: fake.requests.length }); offset += ms; },
  random: () => 1,
  advance: (ms) => { offset += ms; },
};

const as = (s: S, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => t.app.inject({
  method, url, headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': s.csrf }), ...headers },
  ...(payload !== undefined ? { payload: payload as object } : {}),
});
const authorize = async (s: S, body: object, headers?: Record<string, string>) => {
  const r = await as(s, 'POST', '/api/v1/connections/authorize', body, headers);
  expect(r.statusCode, r.body).toBe(200);
  return new URL(r.json().url as string);
};
const callback = (s: S, back: URL) => as(s, 'GET', back.pathname + back.search);
/** Connects an account of the fake for `s` through the whole consent flow; answers the connection id. */
async function connect(s: S, account = 'acct-testuser'): Promise<string> {
  const back = await fake.consent((await authorize(s, { provider: 'fake' })).href, { account });
  const r = await callback(s, back);
  expect(r.statusCode).toBe(302);
  const m = /^\/conn:([0-9a-f]{32})$/.exec(String(r.headers.location));
  expect(m, String(r.headers.location)).not.toBeNull();
  return m![1]!;
}
const connections = async (s: S): Promise<Connection[]> => ((await as(s, 'GET', '/api/v1/connections')).json() as ConnectionList).items;
const rowCount = () => t.db.prepare('SELECT count(*) FROM connections').pluck().get() as number;
const sealedOf = (id: string) => t.db.prepare('SELECT refresh_token FROM connections WHERE id = ?').pluck().get(id) as string;
const storedRefresh = (id: string) => open(t.config.encryptionKey, sealedOf(id), `connections/${id}/refresh_token`);
const list = (s: S, id: string, path = '/') => as(s, 'GET', `/api/v1/sources/conn:${id}/list?path=${encodeURIComponent(path)}`);
const grants = (kind: string) => fake.requests.filter((r) => r.grant === kind).length;
async function unlinkAll(s: S) {
  for (const c of await connections(s)) expect((await as(s, 'DELETE', `/api/v1/connections/${c.id}`)).statusCode).toBe(204);
}

beforeAll(async () => {
  fake = await startFakeProvider({ pageSize: 2 });
  for (const f of ['/Docs/a.txt', '/Docs/b.txt', '/Docs/c.txt', '/top.txt']) fake.put(f, `bytes of ${f}`);
  t = await startTestApp({ FILES_LOG_LEVEL: 'info' }, undefined, logStream, { providers: [fake.provider()], clock });
  for (const [user, set] of [['testuser', (s: S) => { a = s; }], ['member', (s: S) => { b = s; }]] as const) {
    const s = await login(t, user);
    set({ ...s, id: (await t.app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).json().id as string });
  }
});
afterAll(async () => { await t?.close(); await fake?.close(); });
beforeEach(async () => {
  fake.onRequest = undefined;
  clock.sleeps.length = 0;
  await unlinkAll(a); await unlinkAll(b);
});

describe('connecting an account', () => {
  it('runs the authorization code flow with PKCE and lists the files live, across pages', async () => {
    const url = await authorize(a, { provider: 'fake' });
    expect(url.origin + url.pathname).toBe(`${fake.url}/oauth/authorize`);
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const back = await fake.consent(url.href);
    const r = await callback(a, back);
    expect(r.statusCode).toBe(302);
    const id = /^\/conn:([0-9a-f]{32})$/.exec(String(r.headers.location))![1]!;
    expect(await connections(a)).toEqual([expect.objectContaining({ id, source: `conn:${id}`, provider: 'fake',
      providerName: 'Fake Cloud', account: 'testuser@example.com', status: 'ok' })]);
    const l = await list(a, id, '/Docs');
    expect(l.statusCode, l.body).toBe(200);
    expect(l.json().entries.map((e: { name: string }) => e.name)).toEqual(['a.txt', 'b.txt', 'c.txt']); // two pages
    expect(l.json().access).toBe('edit');
    const c = await as(a, 'GET', `/api/v1/sources/conn:${id}/content?path=${encodeURIComponent('/Docs/b.txt')}`);
    expect(c.statusCode).toBe(200);
    expect(c.body).toBe('bytes of /Docs/b.txt'); // through the fake's 302 to a pre-signed URL
  });

  it('connecting the same account again updates its connection instead of adding one', async () => {
    const first = await connect(a);
    expect(await connect(a)).toBe(first);
    expect((await connections(a)).map((c) => c.id)).toEqual([first]);
  });

  it('rejects a callback without state and stores nothing', async () => {
    const back = await fake.consent((await authorize(a, { provider: 'fake' })).href);
    back.searchParams.delete('state');
    const codeGrantsBefore = grants('authorization_code');
    const r = await callback(a, back);
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/connections?error=CONNECT_FAILED');
    expect(rowCount()).toBe(0);
    expect(grants('authorization_code')).toBe(codeGrantsBefore); // the code was never even exchanged
  });

  it('rejects a callback with a wrong state although the session has an attempt open, and stores nothing', async () => {
    const back = await fake.consent((await authorize(a, { provider: 'fake' })).href);
    back.searchParams.set('state', 'A'.repeat(43));
    const r = await callback(a, back);
    expect(r.headers.location).toBe('/connections?error=CONNECT_FAILED');
    expect(rowCount()).toBe(0);
  });

  it('rejects a state that another session started (a callback URL slipped to another member)', async () => {
    const back = await fake.consent((await authorize(a, { provider: 'fake' })).href);
    const r = await callback(b, back);
    expect(r.headers.location).toBe('/connections?error=CONNECT_FAILED');
    expect(rowCount()).toBe(0);
    // The state is single-use and bound to its session: the right session can still finish, but only once.
    expect((await callback(a, back)).headers.location).toMatch(/^\/conn:/);
    expect((await callback(a, back)).headers.location).toBe('/connections?error=CONNECT_FAILED');
    expect(rowCount()).toBe(1);
  });

  it('a denied consent stores nothing and says it was denied, not that it failed (#236 P10)', async () => {
    const back = await fake.consent((await authorize(a, { provider: 'fake' })).href, { deny: true });
    expect((await callback(a, back)).headers.location).toBe('/connections?error=CONNECT_DENIED');
    expect(rowCount()).toBe(0);
  });

  it('a denial is believed only with this session\'s own state (#236 P10)', async () => {
    await authorize(a, { provider: 'fake' });
    const forged = new URL(CALLBACK);
    forged.searchParams.set('error', 'access_denied');
    forged.searchParams.set('state', 'not-a-state-of-this-session');
    expect((await callback(a, forged)).headers.location).toBe('/connections?error=CONNECT_FAILED');
  });

  it('builds the redirect URI from the configured public URL, never from Host or X-Forwarded-Host (#106)', async () => {
    const url = await authorize(a, { provider: 'fake' },
      { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' });
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
    // The code exchange sends the same URI (the fake refuses a different one), so the flow completes behind that Host too.
    const back = await fake.consent(url.href);
    const ok = await t.app.inject({ url: back.pathname + back.search,
      headers: { cookie: a.cookie, host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
    expect(ok.headers.location).toMatch(/^\/conn:[0-9a-f]{32}$/);
    expect(fake.requests.at(-2)).toEqual(expect.objectContaining({ path: '/oauth/token', grant: 'authorization_code' }));
  });

  it('never logs the authorization code, the state or a token of the callback (#106)', async () => {
    logLines.length = 0;
    const back = await fake.consent((await authorize(a, { provider: 'fake' })).href);
    const code = back.searchParams.get('code')!; const state = back.searchParams.get('state')!;
    expect((await callback(a, back)).statusCode).toBe(302);
    // A failing exchange logs its reason (and error), still without the code: replay the spent code with a new state.
    const again = await fake.consent((await authorize(a, { provider: 'fake' })).href);
    again.searchParams.set('code', code);
    expect((await callback(a, again)).headers.location).toBe('/connections?error=CONNECT_FAILED');
    const id = (await connections(a))[0]!.id;
    const secrets = [code, state, again.searchParams.get('state')!, storedRefresh(id),
      ...fake.requests.flatMap((r) => (r.token ? [r.token] : []))];
    const log = logLines.join('');
    expect(log).toContain('/api/v1/connections/callback'); // the request is logged, by path
    expect(log).toContain('code exchange rejected');
    expect(log).not.toContain('code=');
    expect(log).not.toContain('state=');
    for (const s of secrets) expect(log).not.toContain(s);
  });
});

describe('tokens at rest and in flight', () => {
  it('stores the refresh token sealed; a tampered ciphertext fails loudly instead of being sent', async () => {
    const id = await connect(a);
    const sealed = sealedOf(id);
    const plain = fake.validRefreshTokens().find((tok) => storedRefresh(id) === tok)!;
    expect(plain).toBeDefined();
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain(plain);
    expect(Buffer.from(sealed.split('.')[3]!, 'base64url').toString('latin1')).not.toContain(plain);

    // Flip one byte of the ciphertext; the next request needs a refresh, which must open the token.
    const parts = sealed.split('.');
    const ct = Buffer.from(parts[3]!, 'base64url'); ct[0] = ct[0]! ^ 1; parts[3] = ct.toString('base64url');
    t.db.prepare('UPDATE connections SET refresh_token = ? WHERE id = ?').run(parts.join('.'), id);
    fake.expireAccessTokens();
    logLines.length = 0;
    const before = grants('refresh_token');
    const r = await list(a, id);
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ code: 'INTERNAL' });
    expect(grants('refresh_token')).toBe(before); // nothing was sent to the provider
    expect(logLines.join('')).toContain('failed authentication');
    // A sealed token copied into another row does not open there either: it is bound to its row.
    expect(() => open(t.config.encryptionKey, sealed, 'connections/other/refresh_token')).toThrow(/failed authentication/);
  });

  it('persists a rotated refresh token before the next request goes out', async () => {
    const id = await connect(a);
    const first = storedRefresh(id);
    // Every API request the fake receives after the refresh must find the rotated token already in the database.
    const seen: boolean[] = [];
    fake.onRequest = (req) => {
      if (req.path.startsWith('/api/') && grants('refresh_token') > 0) seen.push(fake.validRefreshTokens().includes(storedRefresh(id)));
    };
    fake.expireAccessTokens();
    expect((await list(a, id)).statusCode).toBe(200); // 401 → refresh (rotates) → retry
    const second = storedRefresh(id);
    expect(second).not.toBe(first);
    expect(fake.validRefreshTokens()).toContain(second);
    expect(fake.validRefreshTokens()).not.toContain(first);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    // The rotated token is the one used next time; the old one would be refused (invalid_grant).
    fake.expireAccessTokens();
    expect((await list(a, id)).statusCode).toBe(200);
    expect((await connections(a))[0]!.status).toBe('ok');
  });

  it('10 parallel requests on an access token that the provider expired trigger exactly one refresh', async () => {
    const id = await connect(a);
    fake.expireAccessTokens();
    const before = grants('refresh_token');
    const rs = await Promise.all(Array.from({ length: 10 }, () => list(a, id)));
    expect(rs.map((r) => r.statusCode)).toEqual(Array(10).fill(200));
    expect(grants('refresh_token') - before).toBe(1);
  });

  it('10 parallel requests after the access token ran out on the clock trigger exactly one refresh, before any request', async () => {
    const id = await connect(a);
    expect((await list(a, id)).statusCode).toBe(200); // the access token is in memory now
    clock.advance(2 * 3600_000);
    const before = grants('refresh_token');
    const firstApi = fake.requests.length;
    const rs = await Promise.all(Array.from({ length: 10 }, () => list(a, id)));
    expect(rs.map((r) => r.statusCode)).toEqual(Array(10).fill(200));
    expect(grants('refresh_token') - before).toBe(1);
    // Renewed ahead of time: the first request after the clock jump is the refresh grant, no API request saw a 401.
    expect(fake.requests[firstApi]!.grant).toBe('refresh_token');
  });

  it('waits at least Retry-After (2 s) after a 429, plus bounded jitter, then retries', async () => {
    const id = await connect(a);
    expect((await list(a, id)).statusCode).toBe(200);
    fake.failNext(1, 429, { 'retry-after': '2' });
    const before = fake.requests.length;
    expect((await list(a, id)).statusCode).toBe(200);
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]!.ms).toBeGreaterThanOrEqual(2000);
    expect(clock.sleeps[0]!.ms).toBeLessThanOrEqual(2000 + MAX_JITTER_MS);
    expect(clock.sleeps[0]!.requestsBefore).toBe(before + 1); // the wait came after the 429, before the retry
  });

  it('backs off on 5xx, gives up after the retries, and refuses to wait for a far Retry-After', async () => {
    const id = await connect(a);
    expect((await list(a, id)).statusCode).toBe(200);
    fake.failNext(2, 503);
    expect((await list(a, id)).statusCode).toBe(200);
    expect(clock.sleeps.map((s) => s.ms)).toEqual([500 + MAX_JITTER_MS, 1000 + MAX_JITTER_MS]);
    clock.sleeps.length = 0;
    fake.failNext(1 + MAX_RETRIES, 500); // the first try and every retry fail
    const r = await list(a, id);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ code: 'PROVIDER_UNAVAILABLE' });
    expect(clock.sleeps).toHaveLength(MAX_RETRIES);
    expect((await list(a, id)).statusCode).toBe(200); // nothing left queued
    clock.sleeps.length = 0;
    fake.failNext(1, 429, { 'retry-after': '3600' });
    const far = await list(a, id);
    expect(far.statusCode).toBe(503);
    expect(clock.sleeps).toEqual([]);
  });
});

describe('ownership', () => {
  it('member B cannot list, use, check, re-authenticate or unlink member A\'s connection (404)', async () => {
    const id = await connect(a);
    expect(await connections(b)).toEqual([]);
    const use = await list(b, id);
    expect(use.statusCode).toBe(404);
    expect(use.json()).toEqual({ code: 'SOURCE_NOT_FOUND' });
    expect((await as(b, 'GET', `/api/v1/sources/conn:${id}/content?path=%2Ftop.txt`)).statusCode).toBe(404);
    for (const r of [await as(b, 'DELETE', `/api/v1/connections/${id}`), await as(b, 'POST', `/api/v1/connections/${id}/check`),
      await as(b, 'POST', '/api/v1/connections/authorize', { connection: id })]) {
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ code: 'NOT_FOUND' });
    }
    expect((await connections(a)).map((c) => c.id)).toEqual([id]);
    expect((await list(a, id)).statusCode).toBe(200);
  });

  it('unlinking orphans the shares and public links into the connection; they never come back with a new one (#58)', async () => {
    const id = await connect(a);
    const share = await as(a, 'POST', '/api/v1/shares', { source: `conn:${id}`, path: '/Docs', grantee: b.id, access: 'read' });
    expect(share.statusCode, share.body).toBe(201);
    const shareId = share.json().id as string;
    const link = await as(a, 'POST', '/api/v1/links', { source: `conn:${id}`, path: '/top.txt' });
    expect(link.statusCode, link.body).toBe(201);
    const token = link.json().token as string;
    expect((await as(b, 'GET', `/api/v1/sources/share:${shareId}/list?path=%2F`)).statusCode).toBe(200);

    expect((await as(a, 'DELETE', `/api/v1/connections/${id}`)).statusCode).toBe(204);
    expect(await connections(a)).toEqual([]);
    expect((await list(a, id)).statusCode).toBe(404);
    const incoming = (await as(b, 'GET', '/api/v1/shares/incoming')).json().items as { id: string; orphaned: boolean }[];
    expect(incoming.find((s) => s.id === shareId)?.orphaned).toBe(true);
    expect((await as(b, 'GET', `/api/v1/sources/share:${shareId}/list?path=%2F`)).statusCode).toBe(410);
    expect((await t.app.inject(`/s/${token}/info`)).statusCode).toBe(410);

    // Connecting the same account again is a new connection; the old share stays orphaned.
    const again = await connect(a);
    expect(again).not.toBe(id);
    const after = (await as(b, 'GET', '/api/v1/shares/incoming')).json().items as { id: string; orphaned: boolean }[];
    expect(after.find((s) => s.id === shareId)?.orphaned).toBe(true);
  });
});

describe('status and re-authentication (#41)', () => {
  it('a refused refresh token marks the connection "needs re-auth"; signing in again restores it under the same id', async () => {
    const id = await connect(a);
    fake.revokeRefreshTokens();
    fake.expireAccessTokens();
    const r = await list(a, id);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ code: 'CONNECTION_REAUTH' });
    expect((await connections(a))[0]!.status).toBe('reauth');

    const url = await authorize(a, { connection: id });
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect((await callback(a, await fake.consent(url.href))).headers.location).toBe(`/conn:${id}`);
    expect(await connections(a)).toEqual([expect.objectContaining({ id, status: 'ok' })]);
    expect((await list(a, id)).statusCode).toBe(200);
  });

  it('signing in again with a different account is refused and leaves the connection as it was', async () => {
    const id = await connect(a);
    const before = sealedOf(id);
    const back = await fake.consent((await authorize(a, { connection: id })).href, { account: 'acct-member' });
    expect((await callback(a, back)).headers.location).toBe('/connections?error=CONNECT_ACCOUNT_MISMATCH');
    expect(sealedOf(id)).toBe(before);
    expect(await connections(a)).toEqual([expect.objectContaining({ id, account: 'testuser@example.com' })]);
  });

  it('check asks the provider live and reports the status', async () => {
    const id = await connect(a);
    const ok = await as(a, 'POST', `/api/v1/connections/${id}/check`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(expect.objectContaining({ id, status: 'ok' }));
    fake.revokeRefreshTokens();
    fake.expireAccessTokens();
    const bad = await as(a, 'POST', `/api/v1/connections/${id}/check`);
    expect(bad.statusCode).toBe(200);
    expect(bad.json()).toEqual(expect.objectContaining({ id, status: 'reauth' }));
  });

  it('an unknown provider is NOT_FOUND and the provider list names what the shard offers', async () => {
    const r = await as(a, 'POST', '/api/v1/connections/authorize', { provider: 'nope' });
    expect(r.statusCode).toBe(404);
    expect((await as(a, 'GET', '/api/v1/connections')).json().providers).toEqual([{ id: 'fake', name: 'Fake Cloud' }]);
  });
});
