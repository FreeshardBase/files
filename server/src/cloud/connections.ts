import { createHash, randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Connection, ConnectionStatus, ProviderInfo } from '@files/shared';
import type { Db } from '../db.ts';
import { AppError } from '../errors.ts';
import type { ConnectedBackend } from '../storage/backend.ts';
import { orphanSourceRefs, type PathTable } from '../storage/pathRefs.ts';
import { authorizationUrl, exchangeCode, OAuthClient, type Clock, type Provider, type TokenStore } from './oauth.ts';
import { open, seal } from './secretBox.ts';

/** A consent flow must come back within this time. */
export const CONNECT_TTL_MS = 10 * 60 * 1000;

type Row = { id: string; user_id: string; provider: string; account_id: string; account_label: string; refresh_token: string;
  status: 'ok' | 'reauth'; created_at: string; updated_at: string };
type Attempt = { state: string; user_id: string; provider: string; connection_id: string | null; verifier: string | null };

const COLUMNS = 'id, user_id, provider, account_id, account_label, refresh_token, status, created_at, updated_at';
// The sealed token is bound to its row, so a ciphertext moved into another row does not open.
const context = (id: string) => `connections/${id}/refresh_token`;
const b64url = (b: Buffer) => b.toString('base64url');
const challengeOf = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

export type CallbackQuery = { code?: string; state?: string; error?: string };

/**
 * The members' cloud connections (#148): rows, the consent flow, and one OAuthClient per connection for this process (so
 * every request of a connection shares its access token and its single-flight refresh). A connection is only ever
 * looked up together with its member: another member's id behaves like an unknown one.
 */
export class CloudConnections {
  private clients = new Map<string, OAuthClient>();
  private byId: Map<string, Provider>;

  constructor(private deps: { db: Db; key: Buffer; providers: readonly Provider[]; clock: Clock; redirectUri: string;
    pathTables: readonly PathTable[] }) {
    this.byId = new Map(deps.providers.map((p) => [p.id, p]));
  }

  providers(): ProviderInfo[] { return this.deps.providers.map((p) => ({ id: p.id, name: p.name })); }

  private rows(userId: string): Row[] {
    return this.deps.db.prepare(`SELECT ${COLUMNS} FROM connections WHERE user_id = ? ORDER BY created_at, id`).all(userId) as Row[];
  }
  private row(userId: string, id: string): Row | undefined {
    return this.deps.db.prepare(`SELECT ${COLUMNS} FROM connections WHERE id = ? AND user_id = ?`).get(id, userId) as Row | undefined;
  }

  private view(r: Row): Connection {
    const provider = this.byId.get(r.provider);
    const status: ConnectionStatus = provider ? r.status : 'unavailable';
    return { id: r.id, source: `conn:${r.id}`, provider: r.provider, providerName: provider?.name ?? r.provider,
      account: r.account_label, status, createdAt: r.created_at };
  }

  list(userId: string): Connection[] { return this.rows(userId).map((r) => this.view(r)); }

  /** The store of one row: the refresh token is opened on every read (a tampered value fails loudly here). */
  private store(id: string): TokenStore {
    const { db, key, clock } = this.deps;
    return {
      refreshToken: () => {
        const sealed = db.prepare('SELECT refresh_token FROM connections WHERE id = ?').pluck().get(id) as string | undefined;
        if (sealed === undefined) throw new AppError('SOURCE_NOT_FOUND'); // unlinked while a request was on its way
        return open(key, sealed, context(id));
      },
      saveRefreshToken: (token) => {
        db.prepare('UPDATE connections SET refresh_token = ?, updated_at = ? WHERE id = ?')
          .run(seal(key, token, context(id)), new Date(clock.now()).toISOString(), id);
      },
      setStatus: (status) => {
        db.prepare('UPDATE connections SET status = ?, updated_at = ? WHERE id = ? AND status <> ?')
          .run(status, new Date(clock.now()).toISOString(), id, status);
      },
    };
  }

  private client(r: Row, provider: Provider): OAuthClient {
    let c = this.clients.get(r.id);
    if (!c) { c = new OAuthClient(provider, this.store(r.id), this.deps.clock); this.clients.set(r.id, c); }
    return c;
  }

  /** The member's connections whose provider the shard still offers, as backends (`conn:<id>`). Builds, never calls. */
  backends(userId: string): ConnectedBackend[] {
    return this.rows(userId).flatMap((r) => {
      const provider = this.byId.get(r.provider);
      return provider ? [{ id: r.id, backend: provider.backend(this.client(r, provider)) }] : [];
    });
  }

  /** Starts a consent flow for the session: a new account of `provider`, or signing in again to `connection`. */
  authorize(sessionHash: string, userId: string, req: { provider: string } | { connection: string }): string {
    const existing = 'connection' in req ? this.row(userId, req.connection) : undefined;
    if ('connection' in req && !existing) throw new AppError('NOT_FOUND');
    const provider = this.byId.get(existing ? existing.provider : (req as { provider: string }).provider);
    if (!provider) throw new AppError(existing ? 'PROVIDER_UNAVAILABLE' : 'NOT_FOUND');
    const state = b64url(randomBytes(32));
    const verifier = provider.pkce ? b64url(randomBytes(32)) : null;
    this.deps.db.prepare(`INSERT INTO connect_attempts (state, session_hash, user_id, provider, connection_id, verifier, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(state, sessionHash, userId, provider.id, existing?.id ?? null, verifier,
      new Date(this.deps.clock.now() + CONNECT_TTL_MS).toISOString());
    return authorizationUrl(provider, { redirectUri: this.deps.redirectUri, state,
      ...(verifier !== null ? { challenge: challengeOf(verifier) } : {}) });
  }

  /** The attempt with this state, only for the session that started it; single-use. */
  private takeAttempt(state: string, sessionHash: string): Attempt | undefined {
    const { db, clock } = this.deps;
    return db.transaction(() => {
      const a = db.prepare(`SELECT state, user_id, provider, connection_id, verifier FROM connect_attempts
        WHERE state = ? AND session_hash = ? AND expires_at > ?`).get(state, sessionHash, new Date(clock.now()).toISOString()) as Attempt | undefined;
      if (a) db.prepare('DELETE FROM connect_attempts WHERE state = ?').run(state);
      return a;
    }).immediate();
  }

  /**
   * The provider sent the browser back. Without a state that this session started, nothing is exchanged and nothing is
   * stored. Returns the connection id; throws CONNECT_FAILED (logged with a reason, never with the query).
   */
  async complete(sessionHash: string, userId: string, q: CallbackQuery, log: FastifyBaseLogger): Promise<string> {
    const failed = (reason: string, err?: unknown): never => {
      log.warn({ reason, ...(err !== undefined ? { err } : {}) }, 'connect failed');
      throw new AppError('CONNECT_FAILED');
    };
    if (q.state === undefined) return failed('callback without state');
    const attempt = this.takeAttempt(q.state, sessionHash);
    if (!attempt || attempt.user_id !== userId) return failed('no matching connect attempt for this session');
    if (q.error !== undefined || q.code === undefined) return failed('provider returned no code (consent denied or failed)');
    const provider = this.byId.get(attempt.provider);
    if (!provider) return failed('provider no longer offered');
    const { clock } = this.deps;
    let tokens;
    try {
      tokens = await exchangeCode(provider, clock, { code: q.code, redirectUri: this.deps.redirectUri,
        ...(attempt.verifier !== null ? { verifier: attempt.verifier } : {}) });
    } catch (err) { return failed('code exchange rejected', err); } // handled: becomes CONNECT_FAILED for the member
    let refresh = tokens.refreshToken;
    const temp = new OAuthClient(provider, { refreshToken: () => refresh, saveRefreshToken: (t) => { refresh = t; }, setStatus: () => undefined },
      clock, tokens);
    let account;
    try { account = await provider.account(temp); }
    catch (err) { return failed('account lookup failed', err); } // handled: becomes CONNECT_FAILED for the member
    return this.persist(userId, provider, attempt.connection_id, account, refresh);
  }

  // Writes the tokens of a finished consent: into the connection being re-authenticated, into the row of an account
  // that is connected already, or into a new row.
  private persist(userId: string, provider: Provider, reauthId: string | null, account: { id: string; label: string }, refresh: string): string {
    const { db, key, clock } = this.deps;
    const now = new Date(clock.now()).toISOString();
    const id = db.transaction(() => {
      const same = db.prepare('SELECT id FROM connections WHERE user_id = ? AND provider = ? AND account_id = ?').pluck()
        .get(userId, provider.id, account.id) as string | undefined;
      if (reauthId !== null) {
        if (!this.row(userId, reauthId)) throw new AppError('NOT_FOUND'); // unlinked during the consent
        // Another account under the same connection would hand its shares to files they were never about.
        if (same !== reauthId) throw new AppError('CONNECT_ACCOUNT_MISMATCH');
      }
      const target = reauthId ?? same ?? randomBytes(16).toString('hex');
      if (target === same || target === reauthId) {
        db.prepare(`UPDATE connections SET refresh_token = ?, account_label = ?, status = 'ok', updated_at = ? WHERE id = ?`)
          .run(seal(key, refresh, context(target)), account.label, now, target);
      } else {
        db.prepare(`INSERT INTO connections (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?)`)
          .run(target, userId, provider.id, account.id, account.label, seal(key, refresh, context(target)), now, now);
      }
      return target;
    }).immediate();
    this.clients.delete(id); // the next request starts from the new refresh token
    return id;
  }

  /** Asks the provider who the account is (refreshing as needed), which updates the status; answers the connection. */
  async check(userId: string, id: string, log: FastifyBaseLogger): Promise<Connection> {
    const r = this.row(userId, id);
    if (!r) throw new AppError('NOT_FOUND');
    const provider = this.byId.get(r.provider);
    if (provider) {
      try { await provider.account(this.client(r, provider)); }
      catch (err) { // handled: the status (now `reauth` if the grant was refused) is the answer; anything else is rethrown
        if (!(err instanceof AppError && err.code === 'CONNECTION_REAUTH')) throw err;
        log.info({ connection: id }, 'connection needs re-authentication');
      }
    }
    return this.view(this.row(userId, id)!);
  }

  /**
   * Unlinks the connection: in one transaction its row goes, and every share and public link into it is orphaned (they
   * answer SHARE_ORPHANED, never another source). The provider keeps the grant until the member revokes it there.
   */
  unlink(userId: string, id: string): void {
    const { db, pathTables } = this.deps;
    db.transaction(() => {
      if (!this.row(userId, id)) throw new AppError('NOT_FOUND');
      orphanSourceRefs(db, pathTables, userId, `conn:${id}`);
      db.prepare('DELETE FROM connections WHERE id = ? AND user_id = ?').run(id, userId);
    }).immediate();
    this.clients.delete(id);
  }

  purgeExpiredAttempts(): void {
    this.deps.db.prepare('DELETE FROM connect_attempts WHERE expires_at <= ?').run(new Date(this.deps.clock.now()).toISOString());
  }
}
