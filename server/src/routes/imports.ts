import type { FastifyInstance } from 'fastify';
import { CreateImportRequest } from '@files/shared';
import { requireUser } from '../auth/guard.ts';

/**
 * `/api/v1/imports` (#322): export archives (iCloud Drive, Google Takeout, plain ZIPs) already in the caller's home,
 * extracted into one of its folders. The job is a transfer job of kind `import` (`/api/v1/transfers` for progress,
 * cancel and the report).
 */
export async function registerImportRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/imports', async (req, reply) => {
    const { user } = requireUser(req);
    const body = CreateImportRequest.parse(req.body);
    return reply.status(201).send(await app.deps.transfers.createImport(user.id, body));
  });
}
