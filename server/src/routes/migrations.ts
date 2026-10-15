import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateMigrationRequest, StartCleanupRequest, TransferId, type CleanupPreview, type MigrationScan } from '@files/shared';
import { requireUser } from '../auth/guard.ts';
import { AppError } from '../errors.ts';
import { parseSource, resolveSource } from '../storage/resolveSource.ts';
import { scanFolder } from '../storage/transfers.ts';

const IdP = z.object({ id: TransferId });
const ScanQ = z.object({ source: z.string().min(1), path: z.string().min(1) });

/**
 * `/api/v1/migrations` (#153): a cloud folder or a whole account onto the shard. The jobs themselves are transfer jobs
 * (`/api/v1/transfers`, kind `migration` and `cleanup`); these routes scan, start, and confirm the cleanup. Every
 * lookup is by id and owner, so another member's migration is NOT_FOUND.
 */
export async function registerMigrationRoutes(app: FastifyInstance): Promise<void> {
  const engine = () => app.deps.transfers;

  // The review step: what the folder holds, before anything is copied.
  app.get('/api/v1/migrations/scan', async (req): Promise<MigrationScan> => {
    requireUser(req);
    const q = ScanQ.parse(req.query);
    if (parseSource(q.source).kind !== 'conn') throw new AppError('VALIDATION');
    return scanFolder((await resolveSource(req, q.source)).backend, q.path);
  });

  app.post('/api/v1/migrations', async (req, reply) => {
    const { user } = requireUser(req);
    const body = CreateMigrationRequest.parse(req.body);
    return reply.status(201).send(await engine().createMigration(user.id, body));
  });

  // What the cleanup would delete, with the single-use token that confirms it.
  app.get('/api/v1/migrations/:id/cleanup', async (req): Promise<CleanupPreview> => {
    const { user } = requireUser(req);
    return engine().previewCleanup(user.id, IdP.parse(req.params).id);
  });

  app.post('/api/v1/migrations/:id/cleanup', async (req, reply) => {
    const { user } = requireUser(req);
    const { id } = IdP.parse(req.params);
    const { token } = StartCleanupRequest.parse(req.body);
    return reply.status(201).send(await engine().startCleanup(user.id, id, token));
  });
}
