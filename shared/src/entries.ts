import { z } from 'zod';

export const EntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().startsWith('/'),
  type: z.enum(['file', 'directory']),
  size: z.number().int().nonnegative(),
  modified: z.iso.datetime(),
  mime: z.string().optional(),
});
export type Entry = z.infer<typeof EntrySchema>;

export const ListResponseSchema = z.object({
  entries: z.array(EntrySchema),
  next: z.string().optional(),
});
export type ListResponse = z.infer<typeof ListResponseSchema>;

export const CollisionPolicy = z.enum(['fail', 'replace', 'keep-both']);
export type CollisionPolicy = z.infer<typeof CollisionPolicy>;

/** Body of `move` (rename is a move within the folder) and `copy`. */
export const TransferRequest = z.object({ from: z.string().min(1), to: z.string().min(1), onCollision: CollisionPolicy });
export type TransferRequest = z.infer<typeof TransferRequest>;

/** Body of `delete`: everything goes to the trash in one transaction. */
export const DeleteRequest = z.object({ paths: z.array(z.string().min(1)).min(1).max(1000) });
export type DeleteRequest = z.infer<typeof DeleteRequest>;

export const MeSchema = z.object({
  id: z.string(), displayName: z.string(), email: z.string().optional(),
  role: z.enum(['admin', 'member']), csrfToken: z.string(),
});
export type Me = z.infer<typeof MeSchema>;

/** A trash id: 16 random bytes as hex, the name of the item's bytes in `<home>/.files/trash/`. */
export const TrashId = z.string().regex(/^[0-9a-f]{32}$/);

export const TrashItemSchema = z.object({
  id: TrashId,
  name: z.string().min(1),
  originalPath: z.string().startsWith('/'),
  type: z.enum(['file', 'directory']),
  /** Bytes the item holds on disk; a folder counts its whole tree. */
  size: z.number().int().nonnegative(),
  deletedAt: z.iso.datetime(),
  /** When the expiry job deletes it permanently. */
  expiresAt: z.iso.datetime(),
});
export type TrashItem = z.infer<typeof TrashItemSchema>;

export const TrashListSchema = z.object({
  items: z.array(TrashItemSchema),
  /** Sum of `size`: what the trash adds to the member's usage until it is purged. */
  totalSize: z.number().int().nonnegative(),
  retentionDays: z.number().int().positive(),
});
export type TrashList = z.infer<typeof TrashListSchema>;

/** Body of `trash/restore`: one item back to its original path, with the collision policy for a taken name. */
export const RestoreRequest = z.object({ id: TrashId, onCollision: CollisionPolicy });
export type RestoreRequest = z.infer<typeof RestoreRequest>;

/** One item the member recently wrote (uploaded, copied, moved, renamed or restored), at its current path. */
export const RecentItemSchema = z.object({
  /** Today always `home`; cloud sources add their provider's recent files later (#149–#151). */
  source: z.string().min(1),
  name: z.string().min(1),
  path: z.string().startsWith('/'),
  type: z.enum(['file', 'directory']),
  changedAt: z.iso.datetime(),
});
export type RecentItem = z.infer<typeof RecentItemSchema>;

/** `GET /api/v1/recent`: the caller's own items, newest first. */
export const RecentListSchema = z.object({ items: z.array(RecentItemSchema) });
export type RecentList = z.infer<typeof RecentListSchema>;

/** Body of `trash/delete`: delete these items permanently. */
export const PurgeRequest = z.object({ ids: z.array(TrashId).min(1).max(1000) });
export type PurgeRequest = z.infer<typeof PurgeRequest>;
