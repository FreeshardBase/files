import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PurgeRequest, RestoreRequest, type TrashList } from '@files/shared';
import { AppError } from '../errors.ts';
import { homeBackend } from '../storage/resolveSource.ts';

// The local trash of the caller's home. Cloud sources use the provider's own trash, so there is no source segment.
export async function registerTrashRoutes(app: FastifyInstance): Promise<void> {
  const retentionDays = app.deps.config.trashRetentionDays;

  app.get('/api/v1/trash', async (req): Promise<TrashList> => {
    const items = homeBackend(req).trashItems(retentionDays);
    return { items, totalSize: items.reduce((s, i) => s + i.size, 0), retentionDays };
  });

  // One item per request, so the client can ask the collision question per item like for uploads and moves.
  app.post('/api/v1/trash/restore', async (req) => {
    const home = homeBackend(req);
    const body = RestoreRequest.parse(req.body);
    return home.restore(body.id, body.onCollision);
  });

  // A purge that leaves an item behind is never reported as success; the items that did go stay gone.
  const purged = (r: { failed: string[] }) => {
    if (r.failed.length > 0) throw new AppError('PURGE_FAILED', { count: r.failed.length });
  };

  app.post('/api/v1/trash/delete', async (req, reply) => {
    const home = homeBackend(req);
    const body = PurgeRequest.parse(req.body);
    purged(await home.purge(body.ids, req.log));
    return reply.status(204).send();
  });

  app.post('/api/v1/trash/empty', async (req, reply) => {
    const home = homeBackend(req);
    z.object({}).strict().parse(req.body ?? {});
    purged(await home.purge('all', req.log));
    return reply.status(204).send();
  });
}
