import { z } from 'zod';
import { ERROR_CODES } from './errors.ts';

/**
 * Duplicate finder (#216): a scan groups identical files of the member's home and, if chosen, their cloud connections;
 * the member picks copies to move to the trash. Nothing is deleted by the scan, and every delete is checked again first.
 */

/** Sources one scan covers at most (the home plus connections). */
export const MAX_SCAN_SOURCES = 20;
/** Copies moved to the trash per request at most. */
export const MAX_TRASH_DUPLICATES = 1000;

/**
 * The hash a group's copies share. `sha256`: the home's, computed by the app; the others are the providers' own: Google
 * Drive's `md5`, Dropbox's `dropbox` content hash, Microsoft Graph's `sha1` (OneDrive) or `quickxor`. Hashes are only
 * compared within one algorithm.
 */
export const HASH_ALGORITHMS = ['sha256', 'md5', 'dropbox', 'sha1', 'quickxor'] as const;
export type HashAlgorithm = (typeof HASH_ALGORITHMS)[number];

/** Body of `POST /api/v1/duplicates/scan`: `home` and/or the member's own `conn:<id>` sources. */
export const StartDuplicateScanRequest = z.object({
  sources: z.array(z.string().min(1)).min(1).max(MAX_SCAN_SOURCES),
}).strict();
export type StartDuplicateScanRequest = z.infer<typeof StartDuplicateScanRequest>;

export const DuplicateCopySchema = z.object({
  source: z.string(), path: z.string(), name: z.string(),
  modified: z.string().optional(), mime: z.string().optional(),
});
export type DuplicateCopy = z.infer<typeof DuplicateCopySchema>;

/** Files with the same size and the same hash of one algorithm, oldest first. */
export const DuplicateGroupSchema = z.object({
  id: z.string(), size: z.number().int().positive(), algorithm: z.enum(HASH_ALGORITHMS),
  copies: z.array(DuplicateCopySchema).min(2),
});
export type DuplicateGroup = z.infer<typeof DuplicateGroupSchema>;

export const ScanStatus = z.enum(['idle', 'running', 'completed', 'cancelled']);
export type ScanStatus = z.infer<typeof ScanStatus>;

/**
 * `GET /api/v1/duplicates`: the member's last scan. While it runs: `files` listed so far, then `candidates` (files that
 * share their size with another) and `hashed` of them. `unhashed`: candidates in a cloud that lists no hash for them
 * (never guessed). `failed`: sources that could not be scanned, with the code. `complete` is false when the scan stopped
 * at its entry limit. `groups` exist once it has completed.
 */
export const DuplicateScanSchema = z.object({
  status: ScanStatus,
  sources: z.array(z.string()),
  files: z.number().int().nonnegative(),
  candidates: z.number().int().nonnegative(),
  hashed: z.number().int().nonnegative(),
  unhashed: z.number().int().nonnegative(),
  complete: z.boolean(),
  failed: z.array(z.object({ source: z.string(), code: z.enum(ERROR_CODES) })),
  groups: z.array(DuplicateGroupSchema),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type DuplicateScan = z.infer<typeof DuplicateScanSchema>;

/** Body of `POST /api/v1/duplicates/trash`: copies of the last scan's groups to move to the trash. */
export const TrashDuplicatesRequest = z.object({
  items: z.array(z.object({ source: z.string().min(1), path: z.string().min(1) }).strict()).min(1).max(MAX_TRASH_DUPLICATES),
}).strict();
export type TrashDuplicatesRequest = z.infer<typeof TrashDuplicatesRequest>;

/** Each copy's outcome: moved to the trash, or kept with the reason (`DUPLICATE_CHANGED` when it no longer matches). */
export type TrashDuplicatesResult = { results: { source: string; path: string; trashed: boolean; code?: (typeof ERROR_CODES)[number] }[] };
