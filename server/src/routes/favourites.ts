import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateFavouriteRequest, type Favourite, type FavouriteList } from '@files/shared';
import { AppError } from '../errors.ts';
import { requireUser } from '../auth/guard.ts';
import { normalizeUserPath } from '../storage/resolveInRoot.ts';
import { resolveSource, sourceFor } from '../storage/resolveSource.ts';
import { addFavourite, favouriteName, favouritesOf, removeFavourite, type FavouriteRow } from '../storage/favourites.ts';

const FavouriteId = z.object({ id: z.coerce.number().int().positive() });

const view = (row: FavouriteRow, available: boolean): Favourite => ({ id: row.id, source: row.source, name: favouriteName(row),
  path: row.path, type: row.type, available, createdAt: row.created_at });

// A source that can no longer be resolved for the caller: an unlinked connection or a revoked or orphaned share.
const GONE = new Set(['SOURCE_NOT_FOUND', 'SHARE_ORPHANED']);

// Favourites (#155): the caller's own pinned items across their sources. Only the caller's rows are ever read or removed.
export async function registerFavouriteRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  // A row is available only while its own source still resolves for the caller, through the same `sourceFor` every
  // request uses: a row whose connection was unlinked is marked gone and never resolved again (never another source).
  app.get('/api/v1/favourites', async (req): Promise<FavouriteList> => {
    const { user } = requireUser(req);
    const rows = favouritesOf(db, user.id);
    const live = new Map<string, boolean>();
    for (const source of new Set(rows.filter((r) => r.gone_at === null).map((r) => r.source))) {
      try { await sourceFor(app.deps, user, source); live.set(source, true); }
      catch (err) { // handled: a source that is gone makes its rows unavailable; anything else is rethrown
        if (!(err instanceof AppError && GONE.has(err.code))) throw err;
        live.set(source, false);
      }
    }
    return { items: rows.map((r) => view(r, r.gone_at === null && live.get(r.source) === true)) };
  });

  // The item must exist in a source the caller can read; its type and canonical path come from the source's `stat`.
  app.post('/api/v1/favourites', async (req, reply) => {
    const { user } = requireUser(req);
    const body = CreateFavouriteRequest.parse(req.body);
    const { backend } = await resolveSource(req, body.source);
    const path = normalizeUserPath(body.path);
    // The root of a source is reached from the sidebar; favourites are folders and files in it.
    if (path === '/') throw new AppError('PATH_INVALID');
    const entry = await backend.stat(path);
    const { row, created } = addFavourite(db, user.id, { source: body.source, path: entry.path, type: entry.type });
    return reply.status(created ? 201 : 200).send(view(row, true));
  });

  app.delete('/api/v1/favourites/:id', async (req, reply) => {
    const { user } = requireUser(req);
    const { id } = FavouriteId.parse(req.params);
    if (!removeFavourite(db, user.id, id)) throw new AppError('NOT_FOUND');
    return reply.status(204).send();
  });
}
