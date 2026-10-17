import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateShareRequest, type IncomingShareList, type MemberList, type OutgoingShareList, type Share, type ShareList } from '@files/shared';
import { AppError } from '../errors.ts';
import { requireUser } from '../auth/guard.ts';
import { getUser } from '../users.ts';
import { normalizeUserPath } from '../storage/resolveInRoot.ts';
import { parseSource, resolveSource } from '../storage/resolveSource.ts';
import { incomingShares, otherMembers, outgoingShares, removeShare, sharesOf, upsertShare } from '../storage/shares.ts';

const ShareId = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) });

// Internal shares (#146): members, creating and revoking shares, who has access to an item, "Shared with me". The owner
// of a share is always the caller and the item always lies in one of the caller's own sources.
export async function registerShareRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get('/api/v1/members', async (req): Promise<MemberList> => {
    const { user } = requireUser(req);
    return { items: otherMembers(db, user.id) };
  });

  app.post('/api/v1/shares', async (req, reply) => {
    const { user } = requireUser(req);
    const body = CreateShareRequest.parse(req.body);
    // Only the caller's own items: a share is never shared on (it would outlive the owner's decision to revoke).
    if (parseSource(body.source).kind === 'share') throw new AppError('FORBIDDEN');
    const path = normalizeUserPath(body.path);
    // The whole home is not shared; members share folders and files in it.
    if (path === '/') throw new AppError('PATH_INVALID');
    const grantee = getUser(db, body.grantee);
    if (!grantee) throw new AppError('NOT_FOUND');
    if (grantee.id === user.id) throw new AppError('VALIDATION');
    const { backend } = await resolveSource(req, body.source);
    const entry = await backend.stat(path);
    const row = upsertShare(db, { ownerId: user.id, source: body.source, path: entry.path, type: entry.type,
      granteeId: grantee.id, access: body.access });
    const share: Share = { id: row.id, grantee: { id: grantee.id, displayName: grantee.displayName }, access: row.access,
      createdAt: row.created_at };
    return reply.status(201).send(share);
  });

  // Who has access to one item of the caller's own source.
  app.get('/api/v1/shares', async (req): Promise<ShareList> => {
    const { user } = requireUser(req);
    const q = z.object({ source: z.string().min(1), path: z.string().min(1) }).parse(req.query);
    if (parseSource(q.source).kind === 'share') return { items: [] };
    return { items: sharesOf(db, user.id, q.source, normalizeUserPath(q.path)) };
  });

  // "My shares" (#299): every share the caller granted, across their sources.
  app.get('/api/v1/shares/outgoing', async (req): Promise<OutgoingShareList> => {
    const { user } = requireUser(req);
    return { items: outgoingShares(db, user.id) };
  });

  app.get('/api/v1/shares/incoming', async (req): Promise<IncomingShareList> => {
    const { user } = requireUser(req);
    return { items: incomingShares(db, user.id) };
  });

  // The owner revokes a share, or the grantee removes it from "Shared with me". Effective on the next request.
  app.delete('/api/v1/shares/:id', async (req, reply) => {
    const { user } = requireUser(req);
    const { id } = ShareId.parse(req.params);
    removeShare(db, id, user.id);
    return reply.status(204).send();
  });
}
