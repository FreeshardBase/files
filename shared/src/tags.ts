import { z } from 'zod';
import { ERROR_CODES } from './errors.ts';
import { EntrySchema } from './entries.ts';

// Tags (#212): private to each member, on files and folders of any source the member can edit. A tag is the set of rows
// with its name on the member's items; it has no existence of its own.

/** A tag name is at most this many characters (code points) once trimmed. */
export const MAX_TAG_LENGTH = 40;
/** An item carries at most this many tags. */
export const MAX_TAGS_PER_ITEM = 20;

/** The design-guide tokens a tag's dot is coloured with (`--line`, …), in a fixed order. */
export const TAG_COLORS = ['line', 'accent', 'danger', 'ink', 'ink-muted'] as const;
export type TagColor = (typeof TAG_COLORS)[number];

/** How tag names are compared: NFC, lower case. "Work" and "work" are one tag. */
export const foldTag = (name: string): string => name.normalize('NFC').toLowerCase();

// Control characters, and the bidi controls that would reorder what follows them (as in resolveInRoot).
const FORBIDDEN = /[\p{Cc}\p{Bidi_Control}]/u;

/** The name as stored (trimmed, NFC), or null when it is empty, too long or holds control characters. */
export function normalizeTagName(raw: string): string | null {
  const name = raw.normalize('NFC').trim();
  if (name === '' || [...name].length > MAX_TAG_LENGTH || FORBIDDEN.test(name)) return null;
  return name;
}

/** The colour of a tag, the same everywhere: a hash of the folded name picks one of `TAG_COLORS`. */
export function tagColor(name: string): TagColor {
  let h = 0;
  for (const c of foldTag(name)) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length]!;
}

/** Body of `POST /api/v1/tags/add` and `/remove`: one tag on (or off) items of one source. */
export const TagItemsRequest = z.object({
  source: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1).max(1000),
  tag: z.string().max(200),
}).strict();
export type TagItemsRequest = z.infer<typeof TagItemsRequest>;

/** One item's tags, in the order they were added. */
export const ItemTagsSchema = z.object({ path: z.string().startsWith('/'), tags: z.array(z.string()) });
export type ItemTags = z.infer<typeof ItemTagsSchema>;

/** `GET /api/v1/tags/folder`: the tags of a folder's children (only those that have any). */
export const FolderTagsSchema = z.object({ items: z.array(ItemTagsSchema) });
export type FolderTags = z.infer<typeof FolderTagsSchema>;

/** `GET /api/v1/tags`: the member's tags with the number of items that carry each, by name. */
export const TagListSchema = z.object({
  tags: z.array(z.object({ name: z.string(), color: z.enum(TAG_COLORS), count: z.number().int().positive() })),
});
export type TagList = z.infer<typeof TagListSchema>;

/**
 * One tagged item in the tag view. `ok`: it is there (`entry` is its `stat`); `missing`: its path no longer exists (moved
 * or deleted outside Files); `unavailable`: its source is gone (an unlinked connection, a revoked share); `failed`: its
 * source could not be asked (`error`).
 */
export const TagItemSchema = z.object({
  source: z.string().min(1),
  path: z.string().startsWith('/'),
  name: z.string().min(1),
  type: z.enum(['file', 'directory']),
  state: z.enum(['ok', 'missing', 'unavailable', 'failed']),
  entry: EntrySchema.optional(),
  error: z.object({ code: z.enum(ERROR_CODES) }).optional(),
});
export type TagItem = z.infer<typeof TagItemSchema>;

/** `GET /api/v1/tags/items?name=`: every item with the tag, across the member's sources. */
export const TagItemListSchema = z.object({ name: z.string(), color: z.enum(TAG_COLORS), items: z.array(TagItemSchema) });
export type TagItemList = z.infer<typeof TagItemListSchema>;
