import { z } from 'zod';
import { ERROR_CODES } from './errors.ts';
import { NameRuleSet } from './nameRules.ts';
import { LayoutSchema, SettingsSchema, SortSchema } from './settings.ts';

export const EntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().startsWith('/'),
  type: z.enum(['file', 'directory']),
  size: z.number().int().nonnegative(),
  /** Absent where the source keeps no time for the item (a Dropbox folder, #150). */
  modified: z.iso.datetime().optional(),
  mime: z.string().optional(),
  /**
   * The source cannot tell the size before the download (#236 P4): a Google-native document is exported when it is read.
   * `size` is then 0 and means nothing; the UI shows "–".
   */
  sizeUnknown: z.literal(true).optional(),
});
export type Entry = z.infer<typeof EntrySchema>;

/** What the caller may do in a source: `edit` in their own home, `read` or `edit` in a share (#146). */
export const Access = z.enum(['read', 'edit']);
export type Access = z.infer<typeof Access>;

export const ListResponseSchema = z.object({
  entries: z.array(EntrySchema),
  next: z.string().optional(),
  /** The caller's access to the source, re-checked on this request; the SPA offers changes only with `edit`. */
  access: Access,
  /** The source's name rules (#342), so the SPA checks a name before it sends it. */
  nameRules: NameRuleSet,
});
export type ListResponse = z.infer<typeof ListResponseSchema>;

/** Edge lengths a thumbnail can be asked for (#144); the longer side of the thumbnail has this many pixels. */
export const THUMB_SIZES = [128, 256, 512] as const;
export type ThumbSize = (typeof THUMB_SIZES)[number];

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
  /** The login name from the IdP: the user name the phone setup page shows for WebDAV (#321). */
  login: z.string().optional(),
  role: z.enum(['admin', 'member']), csrfToken: z.string(),
  /** The member's language and theme (#159): the shell applies them with its first request. */
  settings: SettingsSchema,
  /** The member's folder sort (#226). */
  sort: SortSchema,
  /** The member's optional layouts (#218, #219). */
  layout: LayoutSchema,
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
  /** A file's type from its extension, so the list can show its thumbnail like a folder does (#244); absent on a folder. */
  mime: z.string().optional(),
});
export type RecentItem = z.infer<typeof RecentItemSchema>;

/** `GET /api/v1/recent`: the caller's own items, newest first. */
export const RecentListSchema = z.object({ items: z.array(RecentItemSchema) });
export type RecentList = z.infer<typeof RecentListSchema>;

/** A file or folder the member pinned (#155), in any of their sources, at its current path. */
export const FavouriteSchema = z.object({
  id: z.number().int().positive(),
  source: z.string().min(1),
  name: z.string().min(1),
  path: z.string().startsWith('/'),
  type: z.enum(['file', 'directory']),
  /** False once the source is gone (an unlinked connection, a revoked share): the entry is shown but never opened. */
  available: z.boolean(),
  createdAt: z.iso.datetime(),
  /** A file's type from its extension, for its thumbnail (#244); absent on a folder. */
  mime: z.string().optional(),
});
export type Favourite = z.infer<typeof FavouriteSchema>;

/** `GET /api/v1/favourites`: the caller's own favourites, in the order they were added. */
export const FavouriteListSchema = z.object({ items: z.array(FavouriteSchema) });
export type FavouriteList = z.infer<typeof FavouriteListSchema>;

/** `POST /api/v1/favourites`: pin one item of a source the caller can read. */
export const CreateFavouriteRequest = z.object({ source: z.string().min(1), path: z.string().min(1) }).strict();
export type CreateFavouriteRequest = z.infer<typeof CreateFavouriteRequest>;

/** `GET /api/v1/search?q=`: part of a name, matched literally and without regard to case. */
export const SearchQuery = z.object({ q: z.string().trim().min(1).max(200) });
export type SearchQuery = z.infer<typeof SearchQuery>;

/** Results of one source: the home first, then each connected cloud. A source whose search failed has `error`. */
export const SearchGroupSchema = z.object({
  source: z.string().min(1),
  items: z.array(EntrySchema),
  /** The source had more matches than `items` holds; a longer query narrows them. */
  more: z.boolean(),
  error: z.object({ code: z.enum(ERROR_CODES) }).optional(),
});
export type SearchGroup = z.infer<typeof SearchGroupSchema>;

/** `GET /api/v1/search`: one group per source the caller can search. */
export const SearchResponseSchema = z.object({ groups: z.array(SearchGroupSchema) });
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/** Another member of the shard: someone who has signed in at least once. */
export const MemberSchema = z.object({ id: z.string(), displayName: z.string() });
export type Member = z.infer<typeof MemberSchema>;

/** `GET /api/v1/members`: the other members, for the share dialog's picker. */
export const MemberListSchema = z.object({ items: z.array(MemberSchema) });
export type MemberList = z.infer<typeof MemberListSchema>;

/**
 * Body of `POST /api/v1/shares`. The owner is always the caller and `source` one of their own sources, so there is no
 * field to name another owner; unknown fields are refused. Sharing the same item with the same member again changes the
 * access of the existing share.
 */
export const CreateShareRequest = z.object({
  source: z.string().min(1), path: z.string().min(1), grantee: z.string().min(1), access: Access,
}).strict();
export type CreateShareRequest = z.infer<typeof CreateShareRequest>;

/** One member's access to an item of the caller (owner's view: the share dialog and the details drawer). */
export const ShareSchema = z.object({
  id: z.string(), grantee: MemberSchema, access: Access, createdAt: z.iso.datetime(),
});
export type Share = z.infer<typeof ShareSchema>;

/** `GET /api/v1/shares?source=&path=`: who has access to one item of the caller. */
export const ShareListSchema = z.object({ items: z.array(ShareSchema) });
export type ShareList = z.infer<typeof ShareListSchema>;

/** A share the caller granted, with its item in the caller's own source ("My shares", #299). */
export const OutgoingShareSchema = ShareSchema.extend({
  source: z.string(), path: z.string(), type: z.enum(['file', 'directory']),
  /** The item was deleted: the share answers SHARE_ORPHANED until someone removes it. */
  orphaned: z.boolean(),
});
export type OutgoingShare = z.infer<typeof OutgoingShareSchema>;

/** `GET /api/v1/shares/outgoing`: every share the caller granted, across their sources, newest first. */
export const OutgoingShareListSchema = z.object({ items: z.array(OutgoingShareSchema) });
export type OutgoingShareList = z.infer<typeof OutgoingShareListSchema>;

/** An item shared with the caller ("Shared with me"), opened as the source `share:<id>`. */
export const IncomingShareSchema = z.object({
  id: z.string(),
  source: z.string(),
  /** The shared item's own name; the owner's folders above it are not revealed. */
  name: z.string().min(1),
  type: z.enum(['file', 'directory']),
  access: Access,
  owner: MemberSchema,
  createdAt: z.iso.datetime(),
  /** The owner deleted the item: the share answers SHARE_ORPHANED until someone removes it. */
  orphaned: z.boolean(),
});
export type IncomingShare = z.infer<typeof IncomingShareSchema>;

export const IncomingShareListSchema = z.object({ items: z.array(IncomingShareSchema) });
export type IncomingShareList = z.infer<typeof IncomingShareListSchema>;

/** Body of `trash/delete`: delete these items permanently. */
export const PurgeRequest = z.object({ ids: z.array(TrashId).min(1).max(1000) });
export type PurgeRequest = z.infer<typeof PurgeRequest>;

/** A public link's token (#147): 16 random bytes as base64url, the part after `/s/`. */
export const LinkToken = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

/**
 * Fields of a public link the owner sets. `expiresAt` is an ISO date-time with offset in the future, or null for none;
 * the server checks it itself (`unknown` here), so anything it cannot parse is INVALID_EXPIRY, never "no expiry".
 * `maxDownloads` null means no limit, 0 means no downloads. `password` null means none (on update: remove it).
 */
const LinkFields = {
  label: z.string().trim().max(100),
  expiresAt: z.unknown(),
  maxDownloads: z.number().int().min(0).max(1_000_000).nullable(),
  password: z.string().min(1).max(256).nullable(),
};

/** Body of `POST /api/v1/links`: a link to one item of the caller's own source. */
export const CreateLinkRequest = z.object({
  source: z.string().min(1), path: z.string().min(1),
  ...LinkFields, label: LinkFields.label.default(''), expiresAt: LinkFields.expiresAt.optional(),
  maxDownloads: LinkFields.maxDownloads.default(null), password: LinkFields.password.default(null),
}).strict();
export type CreateLinkRequest = z.input<typeof CreateLinkRequest>;

/** Body of `PATCH /api/v1/links/:id`: only the fields given change. */
export const UpdateLinkRequest = z.object({
  label: LinkFields.label.optional(), expiresAt: LinkFields.expiresAt.optional(),
  maxDownloads: LinkFields.maxDownloads.optional(), password: LinkFields.password.optional(),
}).strict();
export type UpdateLinkRequest = z.input<typeof UpdateLinkRequest>;

/** A public link as its owner sees it (the share dialog). The link itself is `/s/<token>` on the shard's origin. */
export const PublicLinkSchema = z.object({
  id: z.string(), token: LinkToken, label: z.string(),
  expiresAt: z.iso.datetime().nullable(), maxDownloads: z.number().int().nonnegative().nullable(),
  /** Byte-serving requests counted so far, previews included. */
  downloads: z.number().int().nonnegative(),
  hasPassword: z.boolean(), createdAt: z.iso.datetime(),
  /** The item was deleted: the link answers SHARE_ORPHANED until the owner revokes it. */
  orphaned: z.boolean(),
});
export type PublicLink = z.infer<typeof PublicLinkSchema>;

/** `GET /api/v1/links?source=&path=`: the caller's links to one item. */
export const PublicLinkListSchema = z.object({ items: z.array(PublicLinkSchema) });
export type PublicLinkList = z.infer<typeof PublicLinkListSchema>;

/** One of the caller's public links with the item it opens ("My shares", #299). */
export const MyLinkSchema = PublicLinkSchema.extend({
  source: z.string(), path: z.string(), type: z.enum(['file', 'directory']),
});
export type MyLink = z.infer<typeof MyLinkSchema>;

/** `GET /api/v1/links/mine`: every public link of the caller, across their sources, newest first. */
export const MyLinkListSchema = z.object({ items: z.array(MyLinkSchema) });
export type MyLinkList = z.infer<typeof MyLinkListSchema>;

/**
 * `GET /s/<token>/info`: what a visitor may know. A locked link (password not entered yet) reveals only the item's name
 * and type; the rest comes once it is unlocked.
 */
export const PublicLinkInfoSchema = z.object({
  name: z.string().min(1), type: z.enum(['file', 'directory']), locked: z.boolean(),
  size: z.number().int().nonnegative().optional(), mime: z.string().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
  /** Downloads left before the limit; null means no limit. */
  downloadsLeft: z.number().int().nonnegative().nullable().optional(),
});
export type PublicLinkInfo = z.infer<typeof PublicLinkInfoSchema>;

/** `POST /s/<token>/unlock`. */
export const UnlockRequest = z.object({ password: z.string().min(1).max(256) }).strict();
export type UnlockRequest = z.infer<typeof UnlockRequest>;

/**
 * One earlier state of a file (#154): a local version kept when the file was overwritten, or a cloud provider's
 * revision. `modified` is when that content was written; `current` marks the provider's revision that is the file now.
 */
export const VersionSchema = z.object({
  id: z.string().min(1), modified: z.iso.datetime(), size: z.number().int().nonnegative().optional(), current: z.boolean().optional(),
});
export type Version = z.infer<typeof VersionSchema>;

/** `GET /api/v1/versions?source=&path=`: oldest first, and what the caller may do with them. */
export const VersionListSchema = z.object({
  versions: z.array(VersionSchema),
  /** The source can restore a version and the caller has `edit`. */
  restore: z.boolean(),
  /** The source serves a version's bytes (the home; cloud revisions are restored, not downloaded). */
  download: z.boolean(),
});
export type VersionList = z.infer<typeof VersionListSchema>;

/** A version id: a local one is 16 random bytes as hex, a provider's is its own revision id. */
export const VersionId = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);

/** `POST /api/v1/versions/restore`: the version becomes the file's content; the content it replaces is kept as a version. */
export const RestoreVersionRequest = z.object({ source: z.string().min(1), path: z.string().min(1), id: VersionId }).strict();
export type RestoreVersionRequest = z.infer<typeof RestoreVersionRequest>;
