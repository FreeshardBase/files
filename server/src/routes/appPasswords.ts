import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateAppPasswordRequest, type AppPasswordList, type CreatedAppPassword } from '@files/shared';
import { requireUser } from '../auth/guard.ts';
import { createAppPassword, listAppPasswords, revokeAppPassword } from '../auth/appPasswords.ts';

/** `/api/v1/app-passwords` (#157): the caller's own app passwords for WebDAV; session and CSRF like every route. */
export async function registerAppPasswordRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get('/api/v1/app-passwords', async (req): Promise<AppPasswordList> => ({ items: listAppPasswords(db, requireUser(req).user.id) }));

  app.post('/api/v1/app-passwords', async (req, reply) => {
    const { user } = requireUser(req);
    const body = CreateAppPasswordRequest.parse(req.body);
    const created: CreatedAppPassword = await createAppPassword(db, user.id, body.label);
    // The password is shown once: no cache may keep the answer.
    return reply.status(201).header('cache-control', 'no-store').send(created);
  });

  app.delete('/api/v1/app-passwords/:id', async (req, reply) => {
    const { user } = requireUser(req);
    const { id } = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }).parse(req.params);
    revokeAppPassword(db, user.id, id);
    return reply.status(204).send();
  });
}
