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
  mode: z.enum(['copy', 'move']),
  from: z.string(), to: z.string(), dir: z.string(),
  /** The name of the first item, for the panel's label. */
  name: z.string(),
  status: TransferStatus,
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
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
