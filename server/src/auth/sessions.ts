import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db.ts';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const token = () => randomBytes(32).toString('base64url');
export const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;
export const LOGIN_TTL_MS = 10 * 60 * 1000;

export function createSession(db: Db, userId: string): { id: string; csrfToken: string; expiresAt: Date } {
  const id = token(); const csrfToken = token();
  const now = new Date(); const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare('INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, expires_at) VALUES (?,?,?,?,?)')
    .run(hash(id), userId, csrfToken, now.toISOString(), expiresAt.toISOString());
  return { id, csrfToken, expiresAt };
}

export type SessionRow = { idHash: string; csrfToken: string; userId: string };
export function findSession(db: Db, id: string): SessionRow | undefined {
  return db.prepare(`SELECT id_hash AS idHash, csrf_token AS csrfToken, user_id AS userId
    FROM sessions WHERE id_hash = ? AND expires_at > ?`).get(hash(id), new Date().toISOString()) as SessionRow | undefined;
}
export function deleteSession(db: Db, idHash: string): void {
  db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
}

/** The most login attempts alive at once (#255): /auth/login is public, so its rows need a bound of their own. */
export const LOGIN_ATTEMPTS_MAX = 10_000;

/**
 * The most live login attempts of one address key (#419): a new one from an address at this ceiling pushes out that
 * address's oldest, so one client cannot fill the table for everyone else.
 */
export const LOGIN_ATTEMPTS_PER_ADDRESS = 50;
/** Login starts one address key may make a minute (#419); a completed sign-in gives the address its full rate back. */
export const LOGIN_STARTS_PER_ADDRESS = 30;
export const LOGIN_STARTS_WINDOW_MS = 60_000;

export type LoginAttempt = { state: string; nonce: string; verifier: string; returnTo: string; address: string };
/**
 * Starts a login attempt after dropping the expired ones. An address at LOGIN_ATTEMPTS_PER_ADDRESS loses its oldest
 * attempt instead; otherwise the attempt is refused (undefined) while LOGIN_ATTEMPTS_MAX are alive.
 */
export function createLoginAttempt(db: Db, a: LoginAttempt): string | undefined {
  const id = token();
  return db.transaction(() => {
    const now = new Date();
    db.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').run(now.toISOString());
    const own = db.prepare('SELECT count(*) FROM login_attempts WHERE address = ?').pluck().get(a.address) as number;
    if (own >= LOGIN_ATTEMPTS_PER_ADDRESS) {
      // Only the address's own attempts go, so a flood can cancel nothing but its own (or its NAT neighbours') logins.
      db.prepare(`DELETE FROM login_attempts WHERE id_hash IN (SELECT id_hash FROM login_attempts WHERE address = ?
        ORDER BY expires_at, rowid LIMIT ?)`).run(a.address, own - LOGIN_ATTEMPTS_PER_ADDRESS + 1);
    } else {
      const live = db.prepare('SELECT count(*) FROM login_attempts').pluck().get() as number;
      // Other addresses' live attempts are never pushed out, so a flood cannot cancel a login a member has started.
      if (live >= LOGIN_ATTEMPTS_MAX) return undefined;
    }
    db.prepare(`INSERT INTO login_attempts (id_hash, state, nonce, verifier, return_to, expires_at, address)
      VALUES (?,?,?,?,?,?,?)`).run(hash(id), a.state, a.nonce, a.verifier, a.returnTo,
      new Date(now.getTime() + LOGIN_TTL_MS).toISOString(), a.address);
    return id;
  })();
}
/** The attempt behind a login cookie, deleted as it is taken; `address` is null for attempts from before #419. */
export function takeLoginAttempt(db: Db, id: string): (Omit<LoginAttempt, 'address'> & { address: string | null }) | undefined {
  return db.transaction(() => {
    const row = db.prepare(`SELECT state, nonce, verifier, return_to AS returnTo, address FROM login_attempts
      WHERE id_hash = ? AND expires_at > ?`).get(hash(id), new Date().toISOString()) as
      (Omit<LoginAttempt, 'address'> & { address: string | null }) | undefined;
    db.prepare('DELETE FROM login_attempts WHERE id_hash = ?').run(hash(id));
    return row;
  })();
}
export function purgeExpired(db: Db): void {
  const now = new Date().toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').run(now);
}
