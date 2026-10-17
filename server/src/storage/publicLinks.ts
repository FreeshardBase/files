import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';
import type { PublicLink } from '@files/shared';
import { AppError } from '../errors.ts';
import type { Db } from '../db.ts';

/** A public link row (#147). `path` is the owner's path in `source`, kept current by the PATH_TABLES cascade for `home`. */
export type LinkRow = { id: string; token: string; owner_id: string; source: string; path: string; type: 'file' | 'directory';
  label: string; password_hash: string | null; expires_at: string | null; max_downloads: number | null; downloads: number;
  created_at: string; orphaned_at: string | null };

const COLUMNS = 'id, token, owner_id, source, path, type, label, password_hash, expires_at, max_downloads, downloads, created_at, orphaned_at';

// `@node-rs/argon2`'s `Algorithm` is a const enum, which isolated modules cannot read; 2 is Argon2id.
const ARGON2ID = 2;
export const hashPassword = (password: string): Promise<string> => hash(password, { algorithm: ARGON2ID });
export const verifyPassword = (passwordHash: string, password: string): Promise<boolean> => verify(passwordHash, password);

/**
 * An expiry as the owner sent it: undefined leaves it as it is, null means none, anything else must be an ISO date-time
 * with offset that lies in the future. Whatever cannot be parsed is INVALID_EXPIRY, never "no expiry" (#104).
 */
export function parseExpiry(value: unknown, now = Date.now()): string | null | undefined {
  if (value === undefined || value === null) return value;
  const iso = z.iso.datetime({ offset: true }).safeParse(value);
  const ms = iso.success ? Date.parse(iso.data) : NaN;
  if (!Number.isFinite(ms) || ms <= now) throw new AppError('INVALID_EXPIRY');
  return new Date(ms).toISOString();
}

/** Expired, or an expiry that cannot be read (fails closed). */
export const isExpired = (row: Pick<LinkRow, 'expires_at'>, now = Date.now()): boolean => {
  if (row.expires_at === null) return false;
  const ms = Date.parse(row.expires_at);
  return !Number.isFinite(ms) || ms <= now;
};

/** Ties an unlock cookie to the password it was earned with: a changed or removed password needs a new unlock. */
export const passwordStamp = (row: Pick<LinkRow, 'password_hash'>): string =>
  createHash('sha256').update(row.password_hash ?? '').digest('base64url').slice(0, 16);

export const toPublicLink = (r: LinkRow): PublicLink => ({ id: r.id, token: r.token, label: r.label, expiresAt: r.expires_at,
  maxDownloads: r.max_downloads, downloads: r.downloads, hasPassword: r.password_hash !== null, createdAt: r.created_at,
  orphaned: r.orphaned_at !== null });

export function createLink(db: Db, l: { ownerId: string; source: string; path: string; type: 'file' | 'directory'; label: string;
  passwordHash: string | null; expiresAt: string | null; maxDownloads: number | null }): LinkRow {
  const id = randomBytes(16).toString('hex');
  const token = randomBytes(16).toString('base64url');
  db.prepare(`INSERT INTO public_links (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)`).run(id, token, l.ownerId,
    l.source, l.path, l.type, l.label, l.passwordHash, l.expiresAt, l.maxDownloads, new Date().toISOString());
  return db.prepare(`SELECT ${COLUMNS} FROM public_links WHERE id = ?`).get(id) as LinkRow;
}

/** The owner's links to one item, orphaned ones included (the owner revokes them), oldest first. */
export function linksOf(db: Db, ownerId: string, source: string, path: string): LinkRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM public_links WHERE owner_id = ? AND source = ? AND path = ?
    ORDER BY created_at, id`).all(ownerId, source, path) as LinkRow[];
}

/** Every link of the owner across their sources, orphaned ones included, newest first ("My shares", #299). */
export function linksOfOwner(db: Db, ownerId: string): LinkRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM public_links WHERE owner_id = ? ORDER BY created_at DESC, id`).all(ownerId) as LinkRow[];
}

/** The link `id` if the caller owns it; anyone else's link looks exactly like an unknown id. */
export function ownLink(db: Db, id: string, ownerId: string): LinkRow {
  const row = db.prepare(`SELECT ${COLUMNS} FROM public_links WHERE id = ? AND owner_id = ?`).get(id, ownerId) as LinkRow | undefined;
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}

export function updateLink(db: Db, id: string, ownerId: string, c: { label?: string; passwordHash?: string | null;
  expiresAt?: string | null; maxDownloads?: number | null }): LinkRow {
  const sets: string[] = []; const args: (string | number | null)[] = [];
  if (c.label !== undefined) { sets.push('label = ?'); args.push(c.label); }
  if (c.passwordHash !== undefined) { sets.push('password_hash = ?'); args.push(c.passwordHash); }
  if (c.expiresAt !== undefined) { sets.push('expires_at = ?'); args.push(c.expiresAt); }
  if (c.maxDownloads !== undefined) { sets.push('max_downloads = ?'); args.push(c.maxDownloads); }
  if (sets.length) db.prepare(`UPDATE public_links SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`).run(...args, id, ownerId);
  return ownLink(db, id, ownerId);
}

/** Revokes a link: the token answers NOT_FOUND from the next request on. */
export function removeLink(db: Db, id: string, ownerId: string): void {
  if (db.prepare('DELETE FROM public_links WHERE id = ? AND owner_id = ?').run(id, ownerId).changes === 0) throw new AppError('NOT_FOUND');
}

export function linkByToken(db: Db, token: string): LinkRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM public_links WHERE token = ?`).get(token) as LinkRow | undefined;
}

/**
 * Counts one byte-serving request against the limit, in one statement, so two requests at once can never both take the
 * last download. False when the limit is reached (a limit of 0 allows none).
 */
export function takeDownload(db: Db, id: string): boolean {
  return db.prepare(`UPDATE public_links SET downloads = downloads + 1
    WHERE id = ? AND (max_downloads IS NULL OR downloads < max_downloads)`).run(id).changes === 1;
}
