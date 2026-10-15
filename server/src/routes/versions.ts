import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RestoreVersionRequest, VersionId, type VersionList } from '@files/shared';
import { AppError } from '../errors.ts';
import { resolveSource, type Access } from '../storage/resolveSource.ts';
import { sendContent } from '../http/content.ts';

const FileQ = z.object({ source: z.string().min(1), path: z.string().min(1) });

// The source first, with the access the route needs, before anything else of the input is used.
async function resolvedFor(req: FastifyRequest, source: string, need: Access) {
  const resolved = await resolveSource(req, source);
  if (need === 'edit' && resolved.access !== 'edit') throw new AppError('FORBIDDEN');
  return resolved;
}

/**
 * Versions of one file (#154): the home's kept versions and the cloud providers' revisions, through the source's
 * backend. Listing and downloading need `read`, restoring `edit` (it overwrites the file).
 */
export async function registerVersionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/versions', async (req): Promise<VersionList> => {
    const q = FileQ.parse(req.query);
    const { backend, access } = await resolvedFor(req, q.source, 'read');
    if (!backend.revisions) throw new AppError('NOT_SUPPORTED');
    return { versions: await backend.revisions(q.path), restore: access === 'edit' && backend.restoreRevision !== undefined,
      download: backend.readRevision !== undefined };
  });

  // Always an attachment: an earlier state of a file is downloaded, never rendered in the app's origin.
  app.get('/api/v1/versions/content', async (req, reply) => {
    const q = FileQ.extend({ id: VersionId }).parse(req.query);
    const { backend } = await resolvedFor(req, q.source, 'read');
    if (!backend.readRevision) throw new AppError('NOT_SUPPORTED');
    return sendContent(reply, await backend.readRevision(q.path, q.id), false, 'private, no-store');
  });

  app.post('/api/v1/versions/restore', async (req) => {
    const body = RestoreVersionRequest.parse(req.body);
    const { backend } = await resolvedFor(req, body.source, 'edit');
    if (!backend.restoreRevision) throw new AppError('NOT_SUPPORTED');
    return backend.restoreRevision(body.path, body.id);
  });
}
