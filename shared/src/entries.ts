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

export const MeSchema = z.object({
  id: z.string(), displayName: z.string(), email: z.string().optional(),
  role: z.enum(['admin', 'member']), csrfToken: z.string(),
});
export type Me = z.infer<typeof MeSchema>;
