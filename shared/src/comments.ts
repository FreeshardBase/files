import { z } from 'zod';
import { MemberSchema } from './entries.ts';

// Comments (#213): one thread per item, kept in Files (also for cloud items) and visible to everyone who can reach the
// item: its owner and, once it is shared, every grantee. Plain text only; the client renders it as text, never markup.

/** A comment is at most this many characters (code points) once trimmed. */
export const MAX_COMMENT_LENGTH = 4000;

// Comments are rows in Files' database, outside every quota (#308): an item holds at most this many live comments, and a
// member has at most this many in all, those waiting in the trash included. More are refused with `COMMENT_LIMIT`.
export const MAX_COMMENTS_PER_ITEM = 500;
export const MAX_COMMENTS_PER_AUTHOR = 20_000;

// Control characters other than line feed and tab, and the bidi controls that would reorder what follows them.
const FORBIDDEN = /[\p{Bidi_Control}]|(?![\n\t])\p{Cc}/u;

/** The text as stored (NFC, CRLF as LF, trimmed), or null when it is empty, too long or holds control characters. */
export function normalizeCommentText(raw: string): string | null {
  const text = raw.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (text === '' || [...text].length > MAX_COMMENT_LENGTH || FORBIDDEN.test(text)) return null;
  return text;
}

/**
 * One comment. `edited` is the time of the last edit. `mine`: the caller wrote it and may edit it; `canDelete`: the
 * caller wrote it or owns the item.
 */
export const CommentSchema = z.object({
  id: z.number().int().positive(),
  author: MemberSchema,
  text: z.string(),
  created: z.iso.datetime(),
  edited: z.iso.datetime().nullable(),
  mine: z.boolean(),
  canDelete: z.boolean(),
});
export type Comment = z.infer<typeof CommentSchema>;

/** `GET /api/v1/comments?source=&path=`: the item's thread, oldest first. */
export const CommentListSchema = z.object({ comments: z.array(CommentSchema) });
export type CommentList = z.infer<typeof CommentListSchema>;

/** Body of `POST /api/v1/comments`. The text is checked by `normalizeCommentText`, so the schema only bounds it. */
export const CreateCommentRequest = z.object({
  source: z.string().min(1), path: z.string().min(1), text: z.string().max(4 * MAX_COMMENT_LENGTH),
}).strict();
export type CreateCommentRequest = z.infer<typeof CreateCommentRequest>;

/** Body of `PATCH /api/v1/comments/:id`: the item the caller reaches it through, and the new text. */
export const EditCommentRequest = CreateCommentRequest;
export type EditCommentRequest = CreateCommentRequest;

/** `GET /api/v1/comments/folder?source=&path=`: how many comments each child of a folder has (only those with any). */
export const FolderCommentsSchema = z.object({
  items: z.array(z.object({ path: z.string().startsWith('/'), count: z.number().int().positive() })),
});
export type FolderComments = z.infer<typeof FolderCommentsSchema>;
