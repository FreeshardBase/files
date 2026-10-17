import type { FastifyInstance } from 'fastify';
import { RenameRequest, type RenamePlan } from '@files/shared';
import { requireUser } from '../auth/guard.ts';

/**
 * `/api/v1/renames` (#215): batch rename in one folder of a source the caller may edit. `preview` answers the plan (old
 * and new names, conflicts, what the chosen policies resolve) without changing anything; `POST` computes the same plan
 * again and starts it as a transfer job of kind `rename`, or refuses with RENAME_CONFLICT while a conflict is open.
 */
export async function registerRenameRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/renames/preview', async (req): Promise<RenamePlan> => {
    const { user } = requireUser(req);
    return app.deps.transfers.previewRename(user.id, RenameRequest.parse(req.body));
  });

  app.post('/api/v1/renames', async (req, reply) => {
    const { user } = requireUser(req);
    return reply.status(201).send(await app.deps.transfers.createRename(user.id, RenameRequest.parse(req.body)));
  });
}
