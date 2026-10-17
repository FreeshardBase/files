import { z } from 'zod';
import { AppError } from '../errors.ts';
import type { Library, Site } from '@files/shared';
import type { StorageBackend } from '../storage/backend.ts';

/** Time and chance, injected so tests can run the backoff on a fake clock. */
export type Clock = { now(): number; sleep(ms: number): Promise<void>; random(): number };
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: () => Math.random(),
};

/**
 * One cloud provider the shard offers (#149–#151 add Google Drive, Dropbox and Microsoft Graph). Its endpoints are fixed
 * by the provider module, never taken from a request: the server only calls these hosts (spec §3.7).
 */
export type Provider = {
  /** Stable id, stored in the connection row. */
  id: string;
  /** The provider's own name, shown as it is. */
  name: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  /** Send a PKCE S256 challenge and the verifier; only where the provider supports it. */
  pkce: boolean;
  /** Extra authorization parameters the provider needs for a refresh token (e.g. `access_type=offline`). */
  authorizationParams?: Readonly<Record<string, string>>;
  /** The account the tokens belong to: a stable id and a label for the member (usually the e-mail address). */
  account(client: OAuthClient): Promise<{ id: string; label: string }>;
  /**
   * The files of the account; every request goes through `client`. `drive` is the library picked through `libraries`
   * (#151), or `''` for the account's own files.
   */
  backend(client: OAuthClient, drive: string): StorageBackend;
  /**
   * Set when a connection shows one of several document libraries the account can reach (SharePoint, #151): the member
   * picks one after the consent, and until then the connection has no files.
   */
  libraries?: LibraryPicker;
  /**
   * Set for a provider whose access token never expires and comes without a refresh token (pCloud, #211). Its own
   * `exchange` trades the code (with the callback's extra parameters) for one credential, which the connection keeps
   * where others keep their refresh token; `bearer` reads the access token out of it. Nothing is ever refreshed, and
   * `tokenEndpoint` is not used.
   */
  longLived?: {
    exchange(clock: Clock, p: { code: string; redirectUri: string; callback: CallbackParams }): Promise<string>;
    bearer(credential: string): string;
  };
};

/** What a provider adds to the callback beyond `code` and `state`: pCloud's region (#211). */
export type CallbackParams = { hostname?: string; locationid?: string };

/** The site and library lookups of the picker; every request goes through the connection's client. */
export type LibraryPicker = {
  sites(client: OAuthClient, query: string): Promise<Site[]>;
  libraries(client: OAuthClient, site: string): Promise<Library[]>;
  /** The label of `library` of `site` ("Site / Library"); NOT_FOUND unless it is one of that site's libraries. */
  label(client: OAuthClient, site: string, library: string): Promise<string>;
};

/** Where an OAuthClient keeps its refresh token: the connection row (encrypted), or memory while connecting. */
export type TokenStore = {
  refreshToken(): string;
  /** Called with a rotated refresh token before the new access token is used, so a crash can never lose it. */
  saveRefreshToken(token: string): void;
  /** `reauth` when the provider refuses the refresh token; `ok` after it accepted one. */
  setStatus(status: 'ok' | 'reauth'): void;
};

const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().nonnegative().optional(),
  refresh_token: z.string().min(1).optional(),
});
export type Tokens = { accessToken: string; expiresAt: number; refreshToken?: string };

/** A token is renewed this long before it expires, so it does not run out on its way to the provider. */
export const EXPIRY_SKEW_MS = 60_000;
/** Without `expires_in`, a token is assumed to last an hour (the common lifetime); a 401 renews it earlier. */
const DEFAULT_TTL_S = 3600;
/** Retries after a 429, a 5xx or a network failure; then the provider counts as unavailable. */
export const MAX_RETRIES = 3;
/** A `Retry-After` longer than this is not waited for: a member's request should not hang that long. */
export const MAX_RETRY_AFTER_MS = 30_000;
/** Backoff without `Retry-After`: 0.5 s, 1 s, 2 s; plus up to this much jitter on every wait. */
const BASE_DELAY_MS = 500;
export const MAX_JITTER_MS = 500;
const TOKEN_TIMEOUT_MS = 30_000;

/** `Retry-After` as milliseconds (delta-seconds or an HTTP date), or undefined when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const retryable = (status: number) => status === 429 || status >= 500;
const discard = async (res: Response) => { await res.body?.cancel(); };

/**
 * Sends `attempt` until it answers something other than 429/5xx, waiting between tries: `Retry-After` when the provider
 * sends one, else exponential backoff, plus jitter either way. A network failure is retried the same way. Gives up
 * with PROVIDER_UNAVAILABLE after MAX_RETRIES, or at once when the provider asks for a wait above MAX_RETRY_AFTER_MS.
 */
async function withBackoff(clock: Clock, attempt: () => Promise<Response>): Promise<Response> {
  for (let tries = 0; ; tries++) {
    let res: Response | undefined;
    let failure: unknown;
    try { res = await attempt(); }
    catch (err) { failure = err; } // handled: a network failure is retried below like a 5xx, then PROVIDER_UNAVAILABLE
    if (res && !retryable(res.status)) return res;
    const asked = res ? retryAfterMs(res.headers.get('retry-after'), clock.now()) : undefined;
    if (res) await discard(res);
    if (tries >= MAX_RETRIES || (asked !== undefined && asked > MAX_RETRY_AFTER_MS)) {
      throw new AppError('PROVIDER_UNAVAILABLE', undefined, failure === undefined ? undefined : { cause: failure });
    }
    await clock.sleep((asked ?? BASE_DELAY_MS * 2 ** tries) + clock.random() * MAX_JITTER_MS);
  }
}

async function tokenRequest(provider: Provider, clock: Clock, params: Record<string, string>): Promise<Tokens> {
  const body = new URLSearchParams({ ...params, client_id: provider.clientId, client_secret: provider.clientSecret });
  const res = await withBackoff(clock, () => fetch(provider.tokenEndpoint, {
    method: 'POST', body, headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  }));
  // The body may echo the grant; only the status is ever put into an error (and so into a log).
  if (res.status === 400 || res.status === 401) { await discard(res); throw new AppError('CONNECTION_REAUTH'); }
  if (!res.ok) { await discard(res); throw new Error(`${provider.id} token endpoint answered ${res.status}`); }
  const parsed = TokenResponse.safeParse(await res.json());
  if (!parsed.success) throw new Error(`${provider.id} token endpoint answered without an access token`);
  const t = parsed.data;
  return { accessToken: t.access_token, expiresAt: clock.now() + (t.expires_in ?? DEFAULT_TTL_S) * 1000,
    ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}) };
}

/** The consent page URL: fixed redirect URI, `state`, and a PKCE challenge where the provider supports it. */
export function authorizationUrl(provider: Provider, p: { redirectUri: string; state: string; challenge?: string }): string {
  const u = new URL(provider.authorizationEndpoint);
  const q = u.searchParams;
  q.set('response_type', 'code');
  q.set('client_id', provider.clientId);
  q.set('redirect_uri', p.redirectUri);
  if (provider.scopes.length > 0) q.set('scope', provider.scopes.join(' '));
  q.set('state', p.state);
  if (p.challenge !== undefined) { q.set('code_challenge', p.challenge); q.set('code_challenge_method', 'S256'); }
  for (const [k, v] of Object.entries(provider.authorizationParams ?? {})) q.set(k, v);
  return u.href;
}

/** Trades the authorization code for tokens. A connection needs a refresh token, so an answer without one fails. */
export async function exchangeCode(provider: Provider, clock: Clock,
  p: { code: string; redirectUri: string; verifier?: string }): Promise<Tokens & { refreshToken: string }> {
  const t = await tokenRequest(provider, clock, { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri,
    ...(p.verifier !== undefined ? { code_verifier: p.verifier } : {}) });
  if (t.refreshToken === undefined) throw new Error(`${provider.id} issued no refresh token`);
  return { ...t, refreshToken: t.refreshToken };
}

export type ProviderRequest = Omit<RequestInit, 'body'> & {
  body?: string | URLSearchParams | Uint8Array;
  /** false: send once and hand back whatever comes (a streamed body cannot be sent twice). */
  retry?: boolean;
};

/**
 * Authenticated requests to one connection's provider. The access token is kept in memory and renewed when it expires or
 * the provider answers 401; concurrent requests share one refresh (single flight). A rotated refresh token is written to
 * the store before the new access token is used. 429 and 5xx are retried with backoff (see `withBackoff`).
 * One instance per connection and process, so the single flight covers every request of the connection.
 */
export class OAuthClient {
  private access: { token: string; expiresAt: number } | undefined;
  private refreshing: Promise<string> | undefined;

  /** `clock` is the connection's time, also for backends that wait on the provider (Graph's copy monitor). */
  constructor(readonly provider: Provider, private store: TokenStore, readonly clock: Clock = systemClock,
    initial?: { accessToken: string; expiresAt: number }) {
    if (initial) this.access = { token: initial.accessToken, expiresAt: initial.expiresAt };
  }

  /** A valid access token, refreshed first when it is missing or about to expire. */
  async accessToken(): Promise<string> {
    if (this.provider.longLived) return this.provider.longLived.bearer(this.store.refreshToken());
    if (this.access && this.clock.now() < this.access.expiresAt - EXPIRY_SKEW_MS) return this.access.token;
    return this.refresh();
  }

  /** The stored credential: a long-lived provider's backend reads its API host from it (pCloud, #211). */
  credential(): string { return this.store.refreshToken(); }

  /** The provider refused the token in an answer's body (pCloud answers 200 with a `result` code): `reauth`. */
  refused(): never {
    this.store.setStatus('reauth');
    throw new AppError('CONNECTION_REAUTH');
  }

  private refresh(): Promise<string> {
    this.refreshing ??= this.doRefresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<string> {
    this.access = undefined;
    let t: Tokens;
    try {
      t = await tokenRequest(this.provider, this.clock, { grant_type: 'refresh_token', refresh_token: this.store.refreshToken() });
    } catch (err) {
      if (err instanceof AppError && err.code === 'CONNECTION_REAUTH') this.store.setStatus('reauth');
      throw err;
    }
    if (t.refreshToken !== undefined && t.refreshToken !== this.store.refreshToken()) this.store.saveRefreshToken(t.refreshToken);
    this.store.setStatus('ok');
    this.access = { token: t.accessToken, expiresAt: t.expiresAt };
    return t.accessToken;
  }

  /**
   * A request with the bearer token. On 401 the token is renewed once (unless another request already did) and the
   * request sent again; a 401 with a fresh token means the provider no longer accepts the grant: CONNECTION_REAUTH.
   */
  async fetch(url: string | URL, init: ProviderRequest = {}): Promise<Response> {
    const { retry = true, ...rest } = init;
    const send = async (token: string) => {
      const headers = new Headers(rest.headers);
      headers.set('authorization', `Bearer ${token}`);
      return fetch(url, { ...rest, headers });
    };
    if (!retry) return send(await this.accessToken());
    let token = await this.accessToken();
    let res = await withBackoff(this.clock, () => send(token));
    if (res.status !== 401) return res;
    await discard(res);
    // Only the request that saw the current token fail renews it; the others pick up the renewed one.
    if (this.access?.token === token) this.access = undefined;
    token = await this.accessToken();
    res = await withBackoff(this.clock, () => send(token));
    if (res.status === 401) { await discard(res); this.store.setStatus('reauth'); throw new AppError('CONNECTION_REAUTH'); }
    return res;
  }
}
