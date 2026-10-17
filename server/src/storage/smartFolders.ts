import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { foldTag, MAX_SMART_FOLDERS, SmartQuery, type Entry, type ParsedSmartQuery, type SmartFolder, type SmartType } from '@files/shared';
import type { Db } from '../db.ts';
import { AppError } from '../errors.ts';
import { lookupMime } from './mime.ts';
import { foldName } from './nameIndex.ts';
import { taggedIn } from './tags.ts';
import type { StorageBackend } from './backend.ts';

// Smart folders (#214): the member's saved queries, and their evaluation against one source at a time.

type Row = { id: string; name: string; query: string; created_at: string; updated_at: string };

// The stored query is what `SmartQuery` produced when it was saved; one that no longer parses is a broken invariant.
function view(r: Row): SmartFolder {
  const q = SmartQuery.safeParse(JSON.parse(r.query));
  if (!q.success) throw new Error(`smart folder ${r.id} holds a query that does not parse: ${q.error.message}`);
  return { id: r.id, name: r.name, query: q.data, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function smartFoldersOf(db: Db, userId: string): SmartFolder[] {
  return (db.prepare('SELECT id, name, query, created_at, updated_at FROM smart_folders WHERE user_id = ? ORDER BY created_at, id')
    .all(userId) as Row[]).map(view);
}

/** One of the member's own smart folders; `NOT_FOUND` for anyone else's. */
export function smartFolderOf(db: Db, userId: string, id: string): SmartFolder {
  const r = db.prepare('SELECT id, name, query, created_at, updated_at FROM smart_folders WHERE id = ? AND user_id = ?')
    .get(id, userId) as Row | undefined;
  if (!r) throw new AppError('NOT_FOUND');
  return view(r);
}

export function createSmartFolder(db: Db, userId: string, name: string, query: ParsedSmartQuery): SmartFolder {
  const id = randomBytes(16).toString('hex');
  db.transaction(() => {
    const n = db.prepare('SELECT count(*) FROM smart_folders WHERE user_id = ?').pluck().get(userId) as number;
    if (n >= MAX_SMART_FOLDERS) throw new AppError('SMART_FOLDER_LIMIT', { max: MAX_SMART_FOLDERS });
    const now = new Date().toISOString();
    db.prepare('INSERT INTO smart_folders (id, user_id, name, query, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, name, JSON.stringify(query), now, now);
  }).immediate();
  return smartFolderOf(db, userId, id);
}

/** Replaces name and query (edit and rename). */
export function updateSmartFolder(db: Db, userId: string, id: string, name: string, query: ParsedSmartQuery): SmartFolder {
  const changed = db.prepare('UPDATE smart_folders SET name = ?, query = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(name, JSON.stringify(query), new Date().toISOString(), id, userId).changes;
  if (changed === 0) throw new AppError('NOT_FOUND');
  return smartFolderOf(db, userId, id);
}

export function deleteSmartFolder(db: Db, userId: string, id: string): void {
  if (db.prepare('DELETE FROM smart_folders WHERE id = ? AND user_id = ?').run(id, userId).changes === 0) throw new AppError('NOT_FOUND');
}

// By extension, like every type in the app (DECISIONS, #214).
const DOCUMENTS = new Set(['pdf', 'txt', 'log', 'md', 'markdown', 'csv', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'doc', 'xls',
  'ppt', 'rtf']);
function isType(e: Entry, type: SmartType): boolean {
  if (type === 'folders') return e.type === 'directory';
  if (e.type !== 'file') return false;
  if (type === 'documents') return DOCUMENTS.has(e.name.includes('.') ? e.name.split('.').pop()!.toLowerCase() : '');
  const mime = e.mime ?? lookupMime(e.name);
  return mime.startsWith(type === 'images' ? 'image/' : 'video/');
}

/** The earliest modified time an item may have, or undefined without a date criterion. */
const cutoffOf = (q: ParsedSmartQuery, now: number) => q.modifiedWithinDays === undefined ? undefined
  : new Date(now - q.modifiedWithinDays * 86_400_000).toISOString();

/** Whether the entry matches every criterion but the tag (which scopes the candidates instead). */
export function matches(q: ParsedSmartQuery, e: Entry, cutoff: string | undefined): boolean {
  if (q.name !== undefined && !foldName(e.name).includes(foldName(q.name))) return false;
  if (q.types && !q.types.some((t) => isType(e, t))) return false;
  if (q.sizeMin !== undefined || q.sizeMax !== undefined) {
    if (e.type !== 'file' || e.size < (q.sizeMin ?? 0) || e.size > (q.sizeMax ?? Number.MAX_SAFE_INTEGER)) return false;
  }
  if (cutoff !== undefined && (e.modified === undefined || Date.parse(e.modified) < Date.parse(cutoff))) return false;
  return true;
}

export type SourceAnswer = { items: Entry[]; more: boolean };

/**
 * The home's answer from its name index (and the tag rows), without touching the disk: SQL narrows by name, tag, type,
 * size and date, then `matches` decides the types the index does not hold (images, video, documents).
 */
export function evaluateHome(db: Db, userId: string, q: ParsedSmartQuery, limit: number, now = Date.now()): SourceAnswer {
  const cutoff = cutoffOf(q, now);
  const where = ['n.user_id = @u'];
  if (q.name !== undefined) where.push('instr(n.name_fold, @q) > 0');
  if (q.types?.length === 1 && q.types[0] === 'folders') where.push(`n.type = 'directory'`);
  else if (q.types && !q.types.includes('folders')) where.push(`n.type = 'file'`);
  if (q.sizeMin !== undefined || q.sizeMax !== undefined) where.push(`n.type = 'file' AND n.size BETWEEN @min AND @max`);
  if (cutoff !== undefined) where.push('n.modified >= @cutoff');
  const join = q.tag === undefined ? '' : `JOIN tags t ON t.user_id = n.user_id AND t.source = 'home' AND t.path = n.path
    AND t.name_fold = @tag AND t.trash_id IS NULL`;
  const rows = db.prepare(`SELECT n.path, n.type, n.size, n.modified FROM name_index n ${join} WHERE ${where.join(' AND ')}
    ORDER BY n.name_fold, n.path`).iterate({
    u: userId, q: q.name === undefined ? '' : foldName(q.name), tag: q.tag === undefined ? '' : foldTag(q.tag),
    min: q.sizeMin ?? 0, max: q.sizeMax ?? Number.MAX_SAFE_INTEGER, cutoff: cutoff ?? '',
  }) as IterableIterator<{ path: string; type: 'file' | 'directory'; size: number; modified: string }>;
  const items: Entry[] = [];
  for (const r of rows) {
    const name = posix.basename(r.path);
    const e: Entry = { name, path: r.path, type: r.type, size: r.size, modified: r.modified, ...(r.type === 'file' ? { mime: lookupMime(name) } : {}) };
    if (!matches(q, e, cutoff)) continue;
    if (items.length === limit) return { items, more: true };
    items.push(e);
  }
  return { items, more: false };
}

/** How many results a cloud's search is asked for, so the post-filter still has enough to choose from. */
const ASK_CLOUD = 200;

/**
 * Another source's answer: with a tag, its tagged items, each `stat`ed (a path that is gone is no result); otherwise the
 * provider's search for the name, post-filtered on what it returns. Without a name or a tag a cloud cannot be asked.
 */
export async function evaluateCloud(db: Db, userId: string, source: string, backend: StorageBackend, q: ParsedSmartQuery,
  limit: number, now = Date.now()): Promise<SourceAnswer> {
  const cutoff = cutoffOf(q, now);
  let candidates: Entry[];
  let capped = false;
  if (q.tag !== undefined) {
    const stated = await Promise.all(taggedIn(db, userId, source, foldTag(q.tag)).map(async (r) => {
      try { return await backend.stat(r.path); }
      catch (e) { // handled: a tagged path that is gone (moved outside Files) is simply no result; anything else fails the source
        if (e instanceof AppError && e.code === 'NOT_FOUND') return null;
        throw e;
      }
    }));
    candidates = stated.filter((e): e is Entry => e !== null);
  } else {
    if (!backend.search) throw new AppError('NOT_SUPPORTED');
    if (q.name === undefined) throw new AppError('SEARCH_NEEDS_NAME');
    candidates = await backend.search(q.name, ASK_CLOUD);
    capped = candidates.length >= ASK_CLOUD;
  }
  const found = candidates.filter((e) => matches(q, e, cutoff));
  return { items: found.slice(0, limit), more: found.length > limit || capped };
}
