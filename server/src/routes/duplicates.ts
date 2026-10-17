import type { FastifyInstance } from 'fastify';
import { StartDuplicateScanRequest, TrashDuplicatesRequest, type DuplicateScan, type TrashDuplicatesResult } from '@files/shared';
import { requireUser } from '../auth/guard.ts';

/**
 * `/api/v1/duplicates` (#216): the caller's duplicate scan. `GET` answers its state (progress while it runs, the groups
 * once it has completed), `scan` starts one over the home and/or the caller's own connections, `cancel` stops it, and
 * `trash` moves copies the caller picked to the trash after checking each again. Nothing is ever deleted otherwise.
 */
export async function registerDuplicateRoutes(app: FastifyInstance): Promise<void> {
  const finder = () => app.deps.duplicates;

  app.get('/api/v1/duplicates', async (req): Promise<DuplicateScan> => finder().get(requireUser(req).user.id));

  app.post('/api/v1/duplicates/scan', async (req, reply) => {
    const { user } = requireUser(req);
    return reply.status(202).send(await finder().start(user.id, StartDuplicateScanRequest.parse(req.body)));
  });

  app.post('/api/v1/duplicates/cancel', async (req): Promise<DuplicateScan> => finder().cancel(requireUser(req).user.id));

  app.post('/api/v1/duplicates/trash', async (req): Promise<TrashDuplicatesResult> => {
    const { user } = requireUser(req);
    return finder().trash(user.id, TrashDuplicatesRequest.parse(req.body));
  });
}
