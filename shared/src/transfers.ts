import { z } from 'zod';
import { CollisionPolicy } from './entries.ts';
import { ERROR_CODES } from './errors.ts';

/** A transfer job's id: 16 random bytes as hex. */
export const TransferId = z.string().regex(/^[0-9a-f]{32}$/);

/**
 * Body of `POST /api/v1/transfers` (#152): copy or move items of one source into the folder `dir` of another source.
 * Each item carries the collision policy the member chose for its name; items they chose to skip are left out.
 */
export const CreateTransferRequest = z.object({
  mode: z.enum(['copy', 'move']),
  from: z.string().min(1),
  to: z.string().min(1),
  dir: z.string().min(1),
  items: z.array(z.object({ path: z.string().min(1), onCollision: CollisionPolicy }).strict()).min(1).max(1000),
}).strict();
export type CreateTransferRequest = z.infer<typeof CreateTransferRequest>;

export const TransferStatus = z.enum(['running', 'completed', 'completed_with_errors', 'cancelled']);
export type TransferStatus = z.infer<typeof TransferStatus>;

/**
 * A job as its owner sees it, in the list, from `GET /api/v1/transfers/:id` and in every SSE `job` event. Items are the
 * files and folders of the job, folders' contents included once they are listed. `done` counts verified items only;
 * `completed` means every item is done, otherwise the job ends `completed_with_errors` with the `failed` items.
 */
export const TransferJobSchema = z.object({
  id: TransferId,
  /**
   * `transfer` between sources (#152), `migration` from a connection to the home, the `cleanup` of one (#153), or a
   * batch `rename` within one folder (#215).
   */
  kind: z.enum(['transfer', 'migration', 'cleanup', 'rename']),
  /** A cleanup's migration, while that job is still listed. */
  origin: TransferId.nullable(),
  mode: z.enum(['copy', 'move']),
  from: z.string(), to: z.string(), dir: z.string(),
  /** The name of the first item, for the panel's label. */
  name: z.string(),
  status: TransferStatus,
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  /** Files among the done items: verified copies (a migration's), or originals deleted (a cleanup's). */
  verifiedFiles: z.number().int().nonnegative(),
  /** Files among all items known so far; once `listing` is false, every file of the job (#227). */
  files: z.number().int().nonnegative(),
  /** Folders (or picked items not yet looked at) still wait to be listed, so `total` and `files` may still grow. */
  listing: z.boolean(),
  cancelled: z.number().int().nonnegative(),
  failed: z.array(z.object({ path: z.string(), code: z.enum(ERROR_CODES) })),
  /** Bytes copied so far, verified items plus the items in flight. */
  bytes: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type TransferJob = z.infer<typeof TransferJobSchema>;

export const TransferListSchema = z.object({ items: z.array(TransferJobSchema) });
export type TransferList = z.infer<typeof TransferListSchema>;

/** A name for one new folder: a single path segment. */
const FolderName = z.string().min(1).max(255).refine((n) => !n.includes('/') && n !== '.' && n !== '..');

/**
 * Body of `POST /api/v1/migrations` (#153): copy the folder `path` of the connection `from` (`/` is the whole account)
 * into a new folder `name` inside the home folder `dir`. A name already taken becomes `name (1)`.
 */
export const CreateMigrationRequest = z.object({
  from: z.string().min(1),
  path: z.string().min(1),
  dir: z.string().min(1),
  name: FolderName,
}).strict();
export type CreateMigrationRequest = z.infer<typeof CreateMigrationRequest>;

/** `GET /api/v1/migrations/scan`: what a migration of the folder would copy; `complete: false` means "at least". */
export const MigrationScanSchema = z.object({
  files: z.number().int().nonnegative(),
  folders: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  complete: z.boolean(),
});
export type MigrationScan = z.infer<typeof MigrationScanSchema>;

/** A single-use confirmation for deleting a migration's verified originals: 16 random bytes as hex. */
export const CleanupToken = z.string().regex(/^[0-9a-f]{32}$/);

/** `GET /api/v1/migrations/:id/cleanup`: what the cleanup would delete, and the token that confirms it. */
export const CleanupPreviewSchema = z.object({
  token: CleanupToken,
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type CleanupPreview = z.infer<typeof CleanupPreviewSchema>;

/** Body of `POST /api/v1/migrations/:id/cleanup`. */
export const StartCleanupRequest = z.object({ token: CleanupToken }).strict();
export type StartCleanupRequest = z.infer<typeof StartCleanupRequest>;
