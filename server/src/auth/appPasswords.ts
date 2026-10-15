import { createHash, randomBytes } from 'node:crypto';
import { MAX_APP_PASSWORDS, type AppPassword } from '@files/shared';
import { AppError } from '../errors.ts';
import type { Db } from '../db.ts';
import { hashPassword, verifyPassword } from '../storage/publicLinks.ts';
import { getUser, type User } from '../users.ts';

// App passwords (#157): 40 characters from an alphabet without look-alikes (no 0/o, 1/l), 5 bits each. The first 8
// characters are the lookup prefix, stored as it is; the other 160 bits are the secret. The row holds the argon2id hash
// of the whole password, so the database never holds anything that signs in.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const LENGTH = 40;
const PREFIX = 8;
export const APP_PASSWORD = new RegExp(`^[${ALPHABET}]{${LENGTH}}$`);

type Row = { id: string; user_id: string; prefix: string; hash: string; label: string; created_at: string; last_used_at: string | null };
const view = (r: Row): AppPassword => ({ id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at });

function generate(): string {
  // 256 is a multiple of 32, so the low five bits of a random byte are uniform.
  return [...randomBytes(LENGTH)].map((b) => ALPHABET[b & 31]).join('');
}

export function listAppPasswords(db: Db, userId: string): AppPassword[] {
  return (db.prepare('SELECT * FROM app_passwords WHERE user_id = ? ORDER BY created_at, id').all(userId) as Row[]).map(view);
}

/** A new app password for the member; the answer is the only place the password ever appears. */
export async function createAppPassword(db: Db, userId: string, label: string): Promise<{ item: AppPassword; password: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const password = generate();
    const hash = await hashPassword(password);
    const row: Row = { id: randomBytes(16).toString('hex'), user_id: userId, prefix: password.slice(0, PREFIX), hash, label,
      created_at: new Date().toISOString(), last_used_at: null };
    const inserted = db.transaction(() => {
      const count = db.prepare('SELECT count(*) FROM app_passwords WHERE user_id = ?').pluck().get(userId) as number;
      if (count >= MAX_APP_PASSWORDS) throw new AppError('APP_PASSWORD_LIMIT', { max: MAX_APP_PASSWORDS });
      // A prefix taken by another password (one in 2^40) gets a new password rather than a second row to check.
      if (db.prepare('SELECT 1 FROM app_passwords WHERE prefix = ?').get(row.prefix)) return false;
      db.prepare(`INSERT INTO app_passwords (id, user_id, prefix, hash, label, created_at)
        VALUES (@id, @user_id, @prefix, @hash, @label, @created_at)`).run(row);
      return true;
    }).immediate();
    if (inserted) return { item: view(row), password };
  }
  throw new Error('no free app password prefix after 3 attempts');
}

/** Removes one of the member's own app passwords; any other id is NOT_FOUND. Takes effect on the next request. */
export function revokeAppPassword(db: Db, userId: string, id: string): void {
  const r = db.prepare('DELETE FROM app_passwords WHERE id = ? AND user_id = ?').run(id, userId);
  if (r.changes === 0) throw new AppError('NOT_FOUND');
  verified.clear();
}

// Clients send the password with every request and argon2id is slow on purpose, so a password that was verified is
// remembered for a few minutes, keyed by its SHA-256 and bound to its row. The row is still read on every request:
// a revoked password is refused at once.
const VERIFIED_MS = 5 * 60_000;
const verified = new Map<string, { id: string; until: number }>();

/** The member an app password belongs to, or undefined. Only the row with the password's prefix is checked. */
export async function authenticateAppPassword(db: Db, password: string): Promise<User | undefined> {
  if (!APP_PASSWORD.test(password)) return undefined;
  const row = db.prepare('SELECT * FROM app_passwords WHERE prefix = ?').get(password.slice(0, PREFIX)) as Row | undefined;
  if (!row) return undefined;
  const key = createHash('sha256').update(password).digest('hex');
  const known = verified.get(key);
  if (!(known && known.id === row.id && known.until > Date.now())) {
    if (!await verifyPassword(row.hash, password)) return undefined;
    if (verified.size > 1000) verified.clear();
    verified.set(key, { id: row.id, until: Date.now() + VERIFIED_MS });
    db.prepare('UPDATE app_passwords SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  }
  return getUser(db, row.user_id);
}
