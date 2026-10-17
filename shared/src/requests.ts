import { z } from 'zod';
import { LinkToken } from './entries.ts';

// File requests (#217): upload-only public links. Anyone with `/r/<token>` may upload into one folder of the owner's
// home or cloud account, and sees only their own uploads of this browser session, never the folder.

/**
 * Fields of a file request the owner sets. `expiresAt` is checked by the server like a public link's (`unknown` here).
 * `maxFiles` and `maxBytes` null mean no limit; `password` null means none (on update: remove it); `askName` shows the
 * visitor an optional name field.
 */
const RequestFields = {
  label: z.string().trim().max(100),
  expiresAt: z.unknown(),
  password: z.string().min(1).max(256).nullable(),
  maxFiles: z.number().int().min(1).max(100_000).nullable(),
  maxBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
  askName: z.boolean(),
};

/** Body of `POST /api/v1/requests`: a request into one folder of the caller's own home or cloud account. */
export const CreateFileRequest = z.object({
  source: z.string().min(1), path: z.string().min(1),
  label: RequestFields.label.default(''), expiresAt: RequestFields.expiresAt.optional(),
  password: RequestFields.password.default(null), maxFiles: RequestFields.maxFiles.default(null),
  maxBytes: RequestFields.maxBytes.default(null), askName: RequestFields.askName.default(false),
}).strict();
export type CreateFileRequest = z.input<typeof CreateFileRequest>;

/** Body of `PATCH /api/v1/requests/:id`: only the fields given change. The target folder stays. */
export const UpdateFileRequest = z.object({
  label: RequestFields.label.optional(), expiresAt: RequestFields.expiresAt.optional(),
  password: RequestFields.password.optional(), maxFiles: RequestFields.maxFiles.optional(),
  maxBytes: RequestFields.maxBytes.optional(), askName: RequestFields.askName.optional(),
}).strict();
export type UpdateFileRequest = z.input<typeof UpdateFileRequest>;

/** A file request as its owner sees it. The request itself is `/r/<token>` on the shard's origin. */
export const FileRequestSchema = z.object({
  id: z.string(), token: LinkToken, label: z.string(), source: z.string(), path: z.string(),
  expiresAt: z.iso.datetime().nullable(), maxFiles: z.number().int().nullable(), maxBytes: z.number().int().nullable(),
  askName: z.boolean(), hasPassword: z.boolean(), createdAt: z.iso.datetime(),
  /** Revoked by the owner: the request answers LINK_REVOKED (410). */
  revoked: z.boolean(),
  /** The target folder was deleted or its cloud account unlinked: the request answers SHARE_ORPHANED (410). */
  orphaned: z.boolean(),
  /** Files received so far, their bytes, and how many of them the owner has not looked at yet (the badge). */
  files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), newFiles: z.number().int().nonnegative(),
});
export type FileRequest = z.infer<typeof FileRequestSchema>;

/** `GET /api/v1/requests`: the caller's file requests, newest first. */
export const FileRequestListSchema = z.object({ items: z.array(FileRequestSchema) });
export type FileRequestList = z.infer<typeof FileRequestListSchema>;

/** One received file as the owner sees it: the name it was saved under in the target folder. */
export const ReceivedFileSchema = z.object({
  name: z.string(), size: z.number().int().nonnegative(), uploader: z.string().nullable(), receivedAt: z.iso.datetime(),
  /** Not yet seen by the owner. */
  new: z.boolean(),
});
export type ReceivedFile = z.infer<typeof ReceivedFileSchema>;

/** `GET /api/v1/requests/:id/files`: newest first. */
export const ReceivedFileListSchema = z.object({ items: z.array(ReceivedFileSchema) });
export type ReceivedFileList = z.infer<typeof ReceivedFileListSchema>;

/** One upload of the visitor's own session: `offset` of `size` bytes are in; `done` once it is saved. */
export const VisitorUploadSchema = z.object({
  id: z.string(), name: z.string(), size: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), done: z.boolean(),
});
export type VisitorUpload = z.infer<typeof VisitorUploadSchema>;

/**
 * `GET /r/<token>/info`: what a visitor may know. A locked request (password not entered yet) reveals only its label.
 * Never the folder, its name or its contents.
 */
export const FileRequestInfoSchema = z.object({
  label: z.string(), locked: z.boolean(),
  askName: z.boolean().optional(), expiresAt: z.iso.datetime().nullable().optional(),
  /** What is left before the limits; null means no limit. */
  filesLeft: z.number().int().nonnegative().nullable().optional(),
  bytesLeft: z.number().int().nonnegative().nullable().optional(),
  uploads: z.array(VisitorUploadSchema).optional(),
});
export type FileRequestInfo = z.infer<typeof FileRequestInfoSchema>;
