import { z } from 'zod';
import { SearchGroupSchema } from './entries.ts';
import { MAX_TAG_LENGTH } from './tags.ts';

// Smart folders (#214): a saved, structured query whose live result is shown like a folder. Every field is a value;
// there is no query language and no regex. The criteria are combined with AND.

/** The kinds of item a query can ask for; an item matches if it is any of them. */
export const SMART_TYPES = ['images', 'video', 'documents', 'folders'] as const;
export type SmartType = (typeof SMART_TYPES)[number];

/** A member keeps at most this many smart folders. */
export const MAX_SMART_FOLDERS = 100;

// The sources global search asks: the home and the member's own connections (shares are not searched, #146).
const SourceId = z.string().regex(/^(home|conn:[A-Za-z0-9_-]{1,64})$/);
// An empty text field is no criterion.
const optionalText = (max: number) => z.string().trim().max(max).optional().transform((s) => (s ? s : undefined));

/**
 * `name`: part of the item's name, without regard to case. `tag`: the member's tag. `modifiedWithinDays`: changed within
 * that many days. `sizeMin`/`sizeMax`: bytes, inclusive, files only. `sources`: which sources to ask (absent: the home and
 * every connection).
 */
export const SmartQuery = z.object({
  name: optionalText(200),
  types: z.array(z.enum(SMART_TYPES)).min(1).max(SMART_TYPES.length).optional(),
  tag: optionalText(MAX_TAG_LENGTH),
  modifiedWithinDays: z.number().int().min(1).max(36_500).optional(),
  sizeMin: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  sizeMax: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  sources: z.array(SourceId).min(1).max(100).optional(),
}).strict()
  .refine((q) => q.sizeMin === undefined || q.sizeMax === undefined || q.sizeMin <= q.sizeMax, { path: ['sizeMax'] })
  .refine((q) => q.name !== undefined || q.types !== undefined || q.tag !== undefined || q.modifiedWithinDays !== undefined
    || q.sizeMin !== undefined || q.sizeMax !== undefined, { path: ['name'] })
  .transform((q) => ({ ...q, ...(q.types ? { types: [...new Set(q.types)] } : {}),
    ...(q.sources ? { sources: [...new Set(q.sources)] } : {}) }));
export type SmartQuery = z.input<typeof SmartQuery>;
export type ParsedSmartQuery = z.output<typeof SmartQuery>;

/** Body of `POST /api/v1/smart-folders` and `PUT /api/v1/smart-folders/:id` (which replaces both). */
export const SaveSmartFolderRequest = z.object({ name: z.string().trim().min(1).max(80), query: SmartQuery }).strict();
export type SaveSmartFolderRequest = z.input<typeof SaveSmartFolderRequest>;

export const SmartFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  query: z.custom<ParsedSmartQuery>(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SmartFolder = z.infer<typeof SmartFolderSchema>;

/** `GET /api/v1/smart-folders`: the member's smart folders, in the order they were created. */
export const SmartFolderListSchema = z.object({ items: z.array(SmartFolderSchema) });
export type SmartFolderList = z.infer<typeof SmartFolderListSchema>;

/** `GET /api/v1/smart-folders/:id/results`: one group per source asked, like global search; a failed source has `error`. */
export const SmartResultsSchema = z.object({ groups: z.array(SearchGroupSchema) });
export type SmartResults = z.infer<typeof SmartResultsSchema>;
