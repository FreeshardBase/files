import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Access, CollisionPolicy, Entry, IncomingShare, Member, Share, ThumbSize } from '@files/shared';
import { AppError } from '../errors.ts';
import type { Db } from '../db.ts';
import { normalizeUserPath } from './resolveInRoot.ts';
import type { ByteRange, StorageBackend, WriteOptions } from './backend.ts';

/** A share row (#146). `path` is the owner's path in `source`, kept current by the PATH_TABLES cascade for `home`. */
export type ShareRow = { id: string; owner_id: string; source: string; path: string; type: 'file' | 'directory';
  grantee_id: string; access: Access; created_at: string; orphaned_at: string | null };

const COLUMNS = 'id, owner_id, source, path, type, grantee_id, access, created_at, orphaned_at';

/** The share `id` if it is granted to `granteeId`; another member's share looks exactly like an unknown id. */
export function grantedShare(db: Db, id: string, granteeId: string): ShareRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM shares WHERE id = ? AND grantee_id = ?`).get(id, granteeId) as ShareRow | undefined;
}

/**
 * Grants `granteeId` access to the owner's item, or changes the access of the live share that already exists for that
 * item and member. One transaction, so two requests at once cannot both insert.
 */
export function upsertShare(db: Db, s: { ownerId: string; source: string; path: string; type: 'file' | 'directory';
  granteeId: string; access: Access }): ShareRow {
  return db.transaction(() => {
    const live = db.prepare(`SELECT id FROM shares WHERE owner_id = ? AND source = ? AND path = ? AND grantee_id = ?
      AND orphaned_at IS NULL`).pluck().get(s.ownerId, s.source, s.path, s.granteeId) as string | undefined;
    const id = live ?? randomBytes(16).toString('hex');
    if (live) db.prepare('UPDATE shares SET access = ? WHERE id = ?').run(s.access, id);
    else {
      db.prepare(`INSERT INTO shares (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(id, s.ownerId, s.source, s.path, s.type, s.granteeId, s.access, new Date().toISOString());
    }
    return db.prepare(`SELECT ${COLUMNS} FROM shares WHERE id = ?`).get(id) as ShareRow;
  }).immediate();
}

type Named = { display_name: string };
const member = (id: string, r: Named): Member => ({ id, displayName: r.display_name });

/** Who has access to one item of the owner (live shares only), by name. */
export function sharesOf(db: Db, ownerId: string, source: string, path: string): Share[] {
  const rows = db.prepare(`SELECT s.id, s.grantee_id, s.access, s.created_at, u.display_name FROM shares s
    JOIN users u ON u.id = s.grantee_id
    WHERE s.owner_id = ? AND s.source = ? AND s.path = ? AND s.orphaned_at IS NULL
    ORDER BY u.display_name COLLATE NOCASE, s.id`).all(ownerId, source, path) as (Named & Pick<ShareRow, 'id' | 'grantee_id' | 'access' | 'created_at'>)[];
  return rows.map((r) => ({ id: r.id, grantee: member(r.grantee_id, r), access: r.access, createdAt: r.created_at }));
}

/** "Shared with me": every share granted to the member, newest first. Only the item's own name is revealed. */
export function incomingShares(db: Db, granteeId: string): IncomingShare[] {
  const rows = db.prepare(`SELECT ${COLUMNS.split(', ').map((c) => `s.${c}`).join(', ')}, u.display_name FROM shares s
    JOIN users u ON u.id = s.owner_id WHERE s.grantee_id = ? ORDER BY s.created_at DESC, s.id`).all(granteeId) as (ShareRow & Named)[];
  return rows.map((r) => ({ id: r.id, source: `share:${r.id}`, name: r.path.slice(r.path.lastIndexOf('/') + 1), type: r.type,
    access: r.access, owner: member(r.owner_id, r), createdAt: r.created_at, orphaned: r.orphaned_at !== null }));
}

/** Removes a share; the owner revokes it, the grantee leaves it. Anyone else gets NOT_FOUND. */
export function removeShare(db: Db, id: string, userId: string): void {
  const r = db.prepare('DELETE FROM shares WHERE id = ? AND (owner_id = ? OR grantee_id = ?)').run(id, userId, userId);
  if (r.changes === 0) throw new AppError('NOT_FOUND');
}

/** The other members of the shard (everyone who has signed in), by name. */
export function otherMembers(db: Db, userId: string): Member[] {
  const rows = db.prepare('SELECT id, display_name FROM users WHERE id <> ? ORDER BY display_name COLLATE NOCASE, id')
    .all(userId) as ({ id: string } & Named)[];
  return rows.map((r) => member(r.id, r));
}

/**
 * The grantee's view of a shared item: `/` is the shared item itself, every other path lies beneath it. Paths are
 * normalised first (no `..`, so nothing above the item can be named) and then prefixed with the owner's path; entries
 * come back with share-relative paths. The item itself can be read and, for a file under `edit`, overwritten, but never
 * renamed, moved, copied or deleted: that would change the owner's tree outside what was shared. Access (`read`/`edit`)
 * is not decided here but by the routes against the share row, on every request.
 */
export class ShareBackend implements StorageBackend {
  constructor(private inner: StorageBackend, private root: string) {}

  private at(p: string): string {
    const n = normalizeUserPath(p);
    return n === '/' ? this.root : this.root + n;
  }
  // A path strictly beneath the shared item.
  private beneath(p: string): string {
    const n = normalizeUserPath(p);
    if (n === '/') throw new AppError('FORBIDDEN');
    return this.root + n;
  }
  private back(e: Entry): Entry {
    if (e.path === this.root) return { ...e, path: '/' };
    if (!e.path.startsWith(this.root + '/')) throw new Error(`entry ${e.path} lies outside the share at ${this.root}`);
    return { ...e, path: e.path.slice(this.root.length) };
  }

  async list(p: string, cursor?: string, limit?: number) {
    const r = await this.inner.list(this.at(p), cursor, limit);
    return { ...r, entries: r.entries.map((e) => this.back(e)) };
  }
  async stat(p: string) { return this.back(await this.inner.stat(this.at(p))); }
  async read(p: string, range?: ByteRange | ((size: number) => ByteRange | undefined)) {
    const r = await this.inner.read(this.at(p), range);
    return { ...r, entry: this.back(r.entry) };
  }
  async write(p: string, body: Readable, opts: WriteOptions) { return this.back(await this.inner.write(this.at(p), body, opts)); }
  async mkdir(p: string) { return this.back(await this.inner.mkdir(this.beneath(p))); }
  async move(from: string, to: string, onCollision: CollisionPolicy) {
    return this.back(await this.inner.move(this.beneath(from), this.beneath(to), onCollision));
  }
  async copy(from: string, to: string, onCollision: CollisionPolicy) {
    return this.back(await this.inner.copy(this.beneath(from), this.beneath(to), onCollision));
  }
  async delete(paths: readonly string[]) { await this.inner.delete(paths.map((p) => this.beneath(p))); }
  async thumbnail(p: string, size: ThumbSize): Promise<Readable | null> {
    return this.inner.thumbnail ? this.inner.thumbnail(this.at(p), size) : null;
  }
}
