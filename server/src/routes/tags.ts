import { posix } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  foldTag, MAX_TAG_LENGTH, normalizeTagName, tagColor, TagItemsRequest,
  type FolderTags, type TagItem, type TagItemList, type TagList,
} from '@files/shared';
import { AppError } from '../errors.ts';
import { requireUser } from '../auth/guard.ts';
import { normalizeUserPath } from '../storage/resolveInRoot.ts';
import { resolveSource, sourceFor } from '../storage/resolveSource.ts';
import { mapLimit, MAX_RESOLVED, sourceFailure, STAT_CONCURRENCY, withinTime } from '../storage/askSources.ts';
import {
  addTag, itemsWithTag, removeTag, spellingOf, tagsInFolder, tagsOfItem, tagSummary, type TagRow,
} from '../storage/tags.ts';

const ItemQuery = z.object({ source: z.string().min(1), path: z.string().min(1) });
const NameQuery = z.object({ name: z.string().trim().min(1).max(200) });

// A source that can no longer be resolved for the caller: an unlinked connection or a revoked or orphaned share.
const GONE = new Set(['SOURCE_NOT_FOUND', 'SHARE_ORPHANED']);

// Tags (#212): the caller's own tags on items of their sources. Only the caller's rows are ever read or changed; adding
// resolves the source with `edit` and `stat`s every item first, removing touches nothing but the caller's rows.
export async function registerTagRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;

  app.get('/api/v1/tags', async (req): Promise<TagList> => {
    const { user } = requireUser(req);
    return { tags: tagSummary(db, user.id).map((t) => ({ ...t, color: tagColor(t.name) })) };
  });

  app.get('/api/v1/tags/item', async (req) => {
    const { user } = requireUser(req);
    const q = ItemQuery.parse(req.query);
    return { tags: tagsOfItem(db, user.id, q.source, normalizeUserPath(q.path)) };
  });

  app.get('/api/v1/tags/folder', async (req): Promise<FolderTags> => {
    const { user } = requireUser(req);
    const q = ItemQuery.parse(req.query);
    return { items: tagsInFolder(db, user.id, q.source, normalizeUserPath(q.path)) };
  });

  // Every item with the tag, each resolved against its own source on open (never another one): a path that is gone is
  // `missing` (changed outside Files), a source that is gone `unavailable`, a source that fails or runs out of time
  // `failed` with its code; the other sources still answer.
  app.get('/api/v1/tags/items', async (req): Promise<TagItemList> => {
    const { user } = requireUser(req);
    const { name } = NameQuery.parse(req.query);
    const fold = foldTag(name);
    const shown = spellingOf(db, user.id, fold) ?? name;
    // The first page of them in tag order (#307); the rest are left for the member to narrow down.
    const tagged = itemsWithTag(db, user.id, fold, MAX_RESOLVED + 1);
    const rows = tagged.slice(0, MAX_RESOLVED);
    const bySource = new Map<string, TagRow[]>();
    for (const r of rows) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);
    const states = new Map<number, Pick<TagItem, 'state' | 'entry' | 'error'>>();
    await Promise.all([...bySource].map(async ([source, items]) => {
      const live = items.filter((r) => r.gone_at === null);
      for (const r of items) if (r.gone_at !== null) states.set(r.id, { state: 'unavailable' });
      if (live.length === 0) return;
      try {
        await withinTime(config.sourceTimeoutMs, async (signal) => {
          let backend;
          try { backend = (await sourceFor(app.deps, user, source)).backend; }
          catch (e) { // handled: a source that is gone makes its items unavailable; anything else fails the source below
            if (!(e instanceof AppError && GONE.has(e.code))) throw e;
            for (const r of live) states.set(r.id, { state: 'unavailable' });
            return;
          }
          // A few at a time (#307): thousands of tagged cloud items must not become thousands of provider requests at once.
          // The answers count only once all are in, so a `stat` that settles after its source failed changes nothing.
          const found = await mapLimit(live, STAT_CONCURRENCY, async (r): Promise<Pick<TagItem, 'state' | 'entry'>> => {
            try { return { state: 'ok', entry: await backend.stat(r.path) }; }
            catch (e) { // handled: a path that is gone is missing; anything else fails the source below
              if (!(e instanceof AppError && e.code === 'NOT_FOUND')) throw e;
              return { state: 'missing' };
            }
          }, signal);
          live.forEach((r, i) => states.set(r.id, found[i]!));
        });
      } catch (e) { // handled: the source's items are reported as failed with its code, next to the other sources
        const code = sourceFailure(e, req.log, source);
        for (const r of live) states.set(r.id, { state: 'failed', error: { code } });
      }
    }));
    return {
      name: shown, color: tagColor(shown), more: tagged.length > MAX_RESOLVED,
      items: rows.map((r) => ({ source: r.source, path: r.path, name: posix.basename(r.path), type: r.type, ...states.get(r.id)! })),
    };
  });

  app.post('/api/v1/tags/add', async (req) => {
    const { user } = requireUser(req);
    const body = TagItemsRequest.parse(req.body);
    const name = normalizeTagName(body.tag);
    if (name === null) throw new AppError('TAG_INVALID', { max: MAX_TAG_LENGTH });
    const { backend, access } = await resolveSource(req, body.source);
    if (access !== 'edit') throw new AppError('FORBIDDEN');
    const items: { path: string; type: 'file' | 'directory' }[] = [];
    for (const raw of new Set(body.paths.map(normalizeUserPath))) {
      // The root of a source is its sidebar entry, not an item.
      if (raw === '/') throw new AppError('PATH_INVALID');
      const entry = await backend.stat(raw);
      items.push({ path: entry.path, type: entry.type });
    }
    addTag(db, user.id, body.source, items, name);
    return { items: items.map((it) => ({ path: it.path, tags: tagsOfItem(db, user.id, body.source, it.path) })) };
  });

  app.post('/api/v1/tags/remove', async (req, reply) => {
    const { user } = requireUser(req);
    const body = TagItemsRequest.parse(req.body);
    removeTag(db, user.id, body.source, body.paths.map(normalizeUserPath), body.tag);
    return reply.status(204).send();
  });
}
