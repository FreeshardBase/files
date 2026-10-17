import { posix } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CreateCommentRequest, EditCommentRequest, MAX_COMMENT_LENGTH, normalizeCommentText,
  type Comment, type CommentList, type FolderComments,
} from '@files/shared';
import { AppError } from '../errors.ts';
import { requireUser } from '../auth/guard.ts';
import { normalizeUserPath } from '../storage/resolveInRoot.ts';
import { resolveSource } from '../storage/resolveSource.ts';
import {
  addComment, commentOf, countsIn, deleteComment, editComment, keysOf, threadOf, type ItemKey,
} from '../storage/comments.ts';

const ItemQuery = z.object({ source: z.string().min(1), path: z.string().min(1) });
const CommentId = z.object({ id: z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number) });

// Comments (#213): every request names the item the way the caller reaches it (`source`, `path`). The source is resolved
// for the caller and the item `stat`ed on every request, so a member who cannot reach it, a revoked share and an unknown
// item all answer 404 before any comment is read; only then is the item's key (owner, owner's source and path) taken.
export async function registerCommentRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  async function reach(req: FastifyRequest, source: string, path: string): Promise<ItemKey> {
    const { user } = requireUser(req);
    const { backend } = await resolveSource(req, source);
    const entry = await backend.stat(normalizeUserPath(path));
    const key = keysOf(db, user.id, source)(entry.path);
    // The root of a source is its sidebar entry, not an item.
    if (key.path === '/') throw new AppError('PATH_INVALID');
    return key;
  }
  const textOf = (raw: string): string => {
    const text = normalizeCommentText(raw);
    if (text === null) throw new AppError('COMMENT_INVALID', { max: MAX_COMMENT_LENGTH });
    return text;
  };

  app.get('/api/v1/comments', async (req): Promise<CommentList> => {
    const { user } = requireUser(req);
    const q = ItemQuery.parse(req.query);
    return { comments: threadOf(db, await reach(req, q.source, q.path), user.id) };
  });

  // The comment counts of a folder's children, for the list's badges. Resolving the source is the access check; paths
  // beneath it cannot leave it (normalised), so the folder itself is not `stat`ed.
  app.get('/api/v1/comments/folder', async (req): Promise<FolderComments> => {
    const { user } = requireUser(req);
    const q = ItemQuery.parse(req.query);
    await resolveSource(req, q.source);
    const dir = normalizeUserPath(q.path);
    const counts = countsIn(db, keysOf(db, user.id, q.source)(dir));
    return { items: counts.map((c) => ({ path: posix.join(dir, posix.basename(c.path)), count: c.count })) };
  });

  // Anyone who can reach the item may comment on it, with `read` access too.
  app.post('/api/v1/comments', async (req, reply) => {
    const { user } = requireUser(req);
    const body = CreateCommentRequest.parse(req.body);
    const key = await reach(req, body.source, body.path);
    const comment: Comment = addComment(db, key, user.id, textOf(body.text));
    return reply.status(201).send(comment);
  });

  // Only the author edits a comment.
  app.patch('/api/v1/comments/:id', async (req): Promise<Comment> => {
    const { user } = requireUser(req);
    const { id } = CommentId.parse(req.params);
    const body = EditCommentRequest.parse(req.body);
    const key = await reach(req, body.source, body.path);
    const found = commentOf(db, key, id, user.id);
    if (!found) throw new AppError('NOT_FOUND');
    if (!found.mine) throw new AppError('FORBIDDEN');
    editComment(db, id, textOf(body.text));
    return commentOf(db, key, id, user.id)!;
  });

  // The author or the item's owner deletes a comment.
  app.delete('/api/v1/comments/:id', async (req, reply) => {
    const { user } = requireUser(req);
    const { id } = CommentId.parse(req.params);
    const q = ItemQuery.parse(req.query);
    const key = await reach(req, q.source, q.path);
    const found = commentOf(db, key, id, user.id);
    if (!found) throw new AppError('NOT_FOUND');
    if (!found.canDelete) throw new AppError('FORBIDDEN');
    deleteComment(db, id);
    return reply.status(204).send();
  });
}
