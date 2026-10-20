import { randomBytes } from 'node:crypto';
import { extname } from 'node:path';
import { MAX_REQUEST_FILES, MAX_REQUEST_FILES_PER_VISITOR, type FileRequest, type ReceivedFile, type VisitorUpload } from '@files/shared';
import { AppError } from '../errors.ts';
import type { Db } from '../db.ts';
import { truncateBytes, type LocalBackend } from './local.ts';
import { isExpired } from './publicLinks.ts';

/** A file request row (#217). `path` is the target folder in `source`, kept current by the PATH_TABLES cascade for `home`. */
export type RequestRow = { id: string; token: string; owner_id: string; source: string; path: string; label: string;
  password_hash: string | null; expires_at: string | null; max_files: number | null; max_bytes: number | null; ask_name: 0 | 1;
  created_at: string; revoked_at: string | null; orphaned_at: string | null };

const COLUMNS = 'id, token, owner_id, source, path, label, password_hash, expires_at, max_files, max_bytes, ask_name, created_at, revoked_at, orphaned_at';
// A visitor's file that counts against the limits: reserved, in progress (its tus upload still open) or received. One
// whose upload expired, was cut off or failed to open no longer counts.
const COUNTS = '(u.placed_at IS NOT NULL OR u.upload_id IS NULL OR u.upload_id IN (SELECT id FROM uploads))';
// A visitor's file not placed yet that still holds the owner's quota: reserved, or its tus upload still open (#304).
const OPEN = '(u.placed_at IS NULL AND (u.upload_id IS NULL OR u.upload_id IN (SELECT id FROM uploads)))';
/** At most this many open uploads per visitor and per request, whatever the limits (#304). */
export const MAX_OPEN_PER_VISITOR = 10;
export const MAX_OPEN_PER_REQUEST = 100;
/**
 * At most this many files per request and per visitor, placed or open, whatever the limits (#401): a zero-byte file passes
 * every byte check yet costs an inode and rows. A request without `max_files` takes `MAX_FILES_PER_REQUEST`.
 */
export const MAX_FILES_PER_REQUEST = MAX_REQUEST_FILES;
export const MAX_FILES_PER_VISITOR = MAX_REQUEST_FILES_PER_VISITOR;

// Control characters, bidi marks and U+FFFD (#379), as `normalizeHomePath` refuses them; here they are dropped instead.
const UNSAFE = /[\p{Cc}\p{Bidi_Control}�]/gu;
const MAX_NAME_BYTES = 255;
/** The name of an upload whose name has nothing left after sanitising. */
export const FALLBACK_NAME = 'upload';

/**
 * The name a visitor's file is saved under (#94): only the last segment after `/` or `\` (a client's folder path or a
 * traversal never reaches the path), without control characters, without leading dots (no hidden file, never the
 * internal area or an upload's temp name) and without leading or trailing spaces and trailing dots, at most 255 bytes
 * with the extension kept. Nothing left is `upload`. Collisions are the placement's job (always keep-both).
 */
export function sanitizeUploadName(raw: string): string {
  const segments = raw.toWellFormed().normalize('NFC').replace(UNSAFE, '').split(/[/\\]/);
  const name = segments[segments.length - 1]!.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
  if (name.length === 0) return FALLBACK_NAME;
  if (Buffer.byteLength(name) <= MAX_NAME_BYTES) return name;
  const ext = extname(name);
  const keepExt = ext.length > 1 && Buffer.byteLength(ext) <= 32;
  return keepExt ? truncateBytes(name.slice(0, -ext.length), MAX_NAME_BYTES - Buffer.byteLength(ext)) + ext : truncateBytes(name, MAX_NAME_BYTES);
}

/** The uploader's name as the visitor typed it: trimmed, without control characters, at most 100 characters; empty is none. */
export function cleanUploader(raw: string | undefined): string | null {
  const name = Array.from((raw ?? '').toWellFormed().replace(UNSAFE, '').trim()).slice(0, 100).join('').trim();
  return name.length > 0 ? name : null;
}

type Usage = { files: number; bytes: number };
/** The request's files and bytes that count, and how many of the files are `visitor`'s. */
function usage(db: Db, requestId: string, visitor: string): Usage & { visitorFiles: number } {
  return db.prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(u.length), 0) AS bytes, COALESCE(SUM(u.visitor = ?), 0) AS visitorFiles
    FROM file_request_uploads u WHERE u.request_id = ? AND ${COUNTS}`).get(visitor, requestId) as Usage & { visitorFiles: number };
}
// The request's file limit in force: the owner's, or the ceiling (never above it: the schema and migration 032).
const fileLimit = (r: RequestRow) => r.max_files ?? MAX_FILES_PER_REQUEST;

export const toFileRequest = (db: Db, r: RequestRow): FileRequest => {
  const received = db.prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(length), 0) AS bytes,
    COALESCE(SUM(seen_at IS NULL), 0) AS fresh FROM file_request_uploads WHERE request_id = ? AND placed_at IS NOT NULL`)
    .get(r.id) as Usage & { fresh: number };
  const pending = db.prepare(`SELECT COUNT(*) FROM file_request_uploads u WHERE u.request_id = ? AND u.placed_at IS NULL
    AND u.upload_id IN (SELECT id FROM uploads)`).pluck().get(r.id) as number;
  return { id: r.id, token: r.token, label: r.label, source: r.source, path: r.path, expiresAt: r.expires_at, maxFiles: r.max_files,
    maxBytes: r.max_bytes, askName: r.ask_name === 1, hasPassword: r.password_hash !== null, createdAt: r.created_at,
    revoked: r.revoked_at !== null, orphaned: r.orphaned_at !== null, files: received.files, bytes: received.bytes, newFiles: received.fresh, pending };
};

/** What is left of the limits for `visitor` right now; null for no byte limit. Files are always bounded (#401). */
export function remaining(db: Db, r: RequestRow, visitor: string): { filesLeft: number; bytesLeft: number | null } {
  const u = usage(db, r.id, visitor);
  return { filesLeft: Math.max(0, Math.min(fileLimit(r) - u.files, MAX_FILES_PER_VISITOR - u.visitorFiles)),
    bytesLeft: r.max_bytes === null ? null : Math.max(0, r.max_bytes - u.bytes) };
}

export function createRequest(db: Db, r: { ownerId: string; source: string; path: string; label: string; passwordHash: string | null;
  expiresAt: string | null; maxFiles: number | null; maxBytes: number | null; askName: boolean }): RequestRow {
  const id = randomBytes(16).toString('hex');
  const token = randomBytes(16).toString('base64url');
  db.prepare(`INSERT INTO file_requests (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run(id, token, r.ownerId,
    r.source, r.path, r.label, r.passwordHash, r.expiresAt, r.maxFiles, r.maxBytes, r.askName ? 1 : 0, new Date().toISOString());
  return db.prepare(`SELECT ${COLUMNS} FROM file_requests WHERE id = ?`).get(id) as RequestRow;
}

/** The owner's requests, revoked and orphaned ones included, newest first. */
export function requestsOf(db: Db, ownerId: string): RequestRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM file_requests WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC`).all(ownerId) as RequestRow[];
}

/** The request `id` if the caller owns it; anyone else's looks exactly like an unknown id. */
export function ownRequest(db: Db, id: string, ownerId: string): RequestRow {
  const row = db.prepare(`SELECT ${COLUMNS} FROM file_requests WHERE id = ? AND owner_id = ?`).get(id, ownerId) as RequestRow | undefined;
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}

export function updateRequest(db: Db, id: string, ownerId: string, c: { label?: string; passwordHash?: string | null;
  expiresAt?: string | null; maxFiles?: number | null; maxBytes?: number | null; askName?: boolean }): RequestRow {
  const sets: string[] = []; const args: (string | number | null)[] = [];
  const set = (column: string, value: string | number | null | undefined) => { if (value !== undefined) { sets.push(`${column} = ?`); args.push(value); } };
  set('label', c.label); set('password_hash', c.passwordHash); set('expires_at', c.expiresAt); set('max_files', c.maxFiles);
  set('max_bytes', c.maxBytes); set('ask_name', c.askName === undefined ? undefined : c.askName ? 1 : 0);
  if (sets.length) db.prepare(`UPDATE file_requests SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`).run(...args, id, ownerId);
  return ownRequest(db, id, ownerId);
}

/**
 * Revokes a request: the token answers LINK_REVOKED from the next request on, uploads in progress included. The caller
 * then terminates its open uploads (`discardOpenUploads`).
 */
export function revokeRequest(db: Db, id: string, ownerId: string): void {
  ownRequest(db, id, ownerId);
  db.prepare('UPDATE file_requests SET revoked_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL').run(new Date().toISOString(), id, ownerId);
}

/** Why the request `id` is no longer live as it is now (revoked, orphaned, expired), or null while it is. */
export function closedCode(db: Db, id: string): 'NOT_FOUND' | 'LINK_REVOKED' | 'SHARE_ORPHANED' | 'LINK_EXPIRED' | null {
  const row = db.prepare('SELECT revoked_at, orphaned_at, expires_at FROM file_requests WHERE id = ?').get(id) as
    Pick<RequestRow, 'revoked_at' | 'orphaned_at' | 'expires_at'> | undefined;
  if (!row) return 'NOT_FOUND';
  if (row.revoked_at !== null) return 'LINK_REVOKED';
  if (row.orphaned_at !== null) return 'SHARE_ORPHANED';
  return isExpired(row) ? 'LINK_EXPIRED' : null;
}

export function requestByToken(db: Db, token: string): RequestRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM file_requests WHERE token = ?`).get(token) as RequestRow | undefined;
}

/**
 * Takes a place for one file of `length` bytes, in one write transaction, so uploads opened at once can never together
 * pass the file or size limit (#196/#197 pattern). Returns the reservation's id; `attachUpload` or `dropReservation` follow.
 */
export function reserveUpload(db: Db, r: RequestRow, u: { visitor: string; name: string; length: number; uploader: string | null }): string {
  const id = randomBytes(16).toString('hex');
  db.transaction(() => {
    // Read again under the write lock: a request revoked since the handler checked it takes no new upload (#304).
    const closed = closedCode(db, r.id);
    if (closed) throw new AppError(closed);
    const used = usage(db, r.id, u.visitor);
    if (used.files + 1 > fileLimit(r) || used.visitorFiles + 1 > MAX_FILES_PER_VISITOR) throw new AppError('REQUEST_FILE_LIMIT');
    if (r.max_bytes !== null && used.bytes + u.length > r.max_bytes) throw new AppError('REQUEST_SIZE_LIMIT');
    // Each open upload holds the owner's quota, a row and a staged file: bounded even without limits (#304).
    const open = db.prepare(`SELECT COUNT(*) AS request, COALESCE(SUM(u.visitor = ?), 0) AS visitor FROM file_request_uploads u
      WHERE u.request_id = ? AND ${OPEN}`).get(u.visitor, r.id) as { request: number; visitor: number };
    if (open.visitor >= MAX_OPEN_PER_VISITOR || open.request >= MAX_OPEN_PER_REQUEST) throw new AppError('REQUEST_UPLOADS_OPEN');
    db.prepare(`INSERT INTO file_request_uploads (id, request_id, visitor, upload_id, name, length, uploader, created_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`).run(id, r.id, u.visitor, u.name, u.length, u.uploader, new Date().toISOString());
  }).immediate();
  return id;
}

export function attachUpload(db: Db, reservation: string, uploadId: string): void {
  db.prepare('UPDATE file_request_uploads SET upload_id = ? WHERE id = ?').run(uploadId, reservation);
}

export function dropReservation(db: Db, reservation: string): void {
  db.prepare('DELETE FROM file_request_uploads WHERE id = ? AND upload_id IS NULL').run(reservation);
}

/**
 * Terminates the request's open uploads in the owner's home `home` (#304): the staged bytes and the `uploads` row go, so
 * the reservation is freed at once, and so does the request's row of each. One receiving bytes right now is left
 * (`busy`); the upload expiry job takes it once the request is no longer live, or after `VISITOR_UPLOAD_TTL_MS`.
 */
export async function discardOpenUploads(db: Db, home: LocalBackend, requestId: string): Promise<{ removed: string[]; busy: string[] }> {
  const ids = db.prepare(`SELECT upload_id FROM file_request_uploads WHERE request_id = ? AND placed_at IS NULL
    AND upload_id IN (SELECT id FROM uploads)`).pluck().all(requestId) as string[];
  const result = { removed: [] as string[], busy: [] as string[] };
  for (const id of ids) {
    try { await home.terminateUpload(id); } catch (e) {
      // handled: a busy upload is left for the expiry job and reported as busy; one gone meanwhile only loses its row
      if (e instanceof AppError && e.code === 'UPLOAD_LOCKED') { result.busy.push(id); continue; }
      if (!(e instanceof AppError && e.code === 'NOT_FOUND')) throw e;
    }
    db.prepare('DELETE FROM file_request_uploads WHERE upload_id = ? AND placed_at IS NULL').run(id);
    result.removed.push(id);
  }
  return result;
}

/** Requests that are no longer live (revoked, orphaned or expired) yet still have open uploads, for the expiry job. */
export function closedWithOpenUploads(db: Db, now: Date): RequestRow[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM file_requests r WHERE EXISTS (SELECT 1 FROM file_request_uploads u
    WHERE u.request_id = r.id AND u.placed_at IS NULL AND u.upload_id IN (SELECT id FROM uploads))`).all() as RequestRow[];
  return rows.filter((r) => r.revoked_at !== null || r.orphaned_at !== null || isExpired(r, now.getTime()));
}

/** Reservations that never got their upload (the process stopped in between) hold no place after a restart. */
export function clearReservations(db: Db): void {
  db.prepare('DELETE FROM file_request_uploads WHERE upload_id IS NULL AND placed_at IS NULL').run();
}

/** True if `uploadId` is an upload of this visitor to this request that is still in progress. */
export function isVisitorsOpenUpload(db: Db, requestId: string, visitor: string, uploadId: string): boolean {
  return db.prepare(`SELECT 1 FROM file_request_uploads u WHERE u.request_id = ? AND u.visitor = ? AND u.upload_id = ?
    AND u.placed_at IS NULL AND u.upload_id IN (SELECT id FROM uploads)`).get(requestId, visitor, uploadId) !== undefined;
}

export function markPlaced(db: Db, uploadId: string, name: string): void {
  db.prepare('UPDATE file_request_uploads SET placed_name = ?, placed_at = ? WHERE upload_id = ?').run(name, new Date().toISOString(), uploadId);
}

/**
 * The visitor's own uploads to this request that are in progress or received, oldest first. Each under the name sent, never
 * the saved one: keep-both numbers it only when the folder holds that name, which would let the visitor probe it (#305).
 */
export function visitorUploads(db: Db, requestId: string, visitor: string): VisitorUpload[] {
  const rows = db.prepare(`SELECT u.upload_id AS id, u.name, u.length AS size,
      CASE WHEN u.placed_at IS NOT NULL THEN u.length ELSE COALESCE(up.received, 0) END AS offset, u.placed_at IS NOT NULL AS done
    FROM file_request_uploads u LEFT JOIN uploads up ON up.id = u.upload_id
    WHERE u.request_id = ? AND u.visitor = ? AND u.upload_id IS NOT NULL AND (u.placed_at IS NOT NULL OR up.id IS NOT NULL)
    ORDER BY u.created_at, u.rowid`).all(requestId, visitor) as (Omit<VisitorUpload, 'done'> & { done: number })[];
  return rows.map((r) => ({ ...r, done: r.done === 1 }));
}

/** Files received through the request, newest first. */
export function receivedFiles(db: Db, requestId: string): ReceivedFile[] {
  const rows = db.prepare(`SELECT placed_name AS name, length AS size, uploader, placed_at AS receivedAt, seen_at IS NULL AS fresh
    FROM file_request_uploads WHERE request_id = ? AND placed_at IS NOT NULL ORDER BY placed_at DESC, rowid DESC`).all(requestId) as
    (Omit<ReceivedFile, 'new'> & { fresh: number })[];
  return rows.map(({ fresh, ...r }) => ({ ...r, new: fresh === 1 }));
}

/** The owner has looked at the received files: the badge goes. */
export function markSeen(db: Db, requestId: string): void {
  db.prepare('UPDATE file_request_uploads SET seen_at = ? WHERE request_id = ? AND placed_at IS NOT NULL AND seen_at IS NULL')
    .run(new Date().toISOString(), requestId);
}
