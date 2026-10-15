import { z } from 'zod';
import type { ErrorCode } from './errors.ts';

// The storage overview and per-member quotas (#156).

/** A shard quota in bytes; `null` removes it (no quota, only the disk limits). */
export const QuotaBytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Body of `PUT /api/v1/admin/members/:id/quota`. */
export const SetQuotaRequest = z.strictObject({ quotaBytes: QuotaBytes.nullable() });
export type SetQuotaRequest = z.infer<typeof SetQuotaRequest>;

/** A member's internal user id (a UUID). */
export const MemberId = z.uuid();

/**
 * Bytes under a member's home, all of which count towards the quota: the files themselves, the trash, kept versions,
 * and uploads in progress (staged tus bytes and interrupted copies). `total` is their sum.
 */
export type HomeUsage = { files: number; trash: number; versions: number; uploads: number; total: number };

/** A folder of the home and the bytes of every file beneath it. */
export type LargeFolder = { path: string; size: number };

/** A cloud provider's own figures for the account: `total` is missing where the account has no limit. */
export type ProviderQuota = { used: number; total?: number };

/** One of the caller's connections: its provider quota, or the error code asking for it gave. */
export type ConnectionUsage = { source: string; quota?: ProviderQuota; error?: { code: ErrorCode } };

/** `GET /api/v1/storage`: the caller's own usage per source. */
export type StorageOverview = {
  home: { usage: HomeUsage; quota: number | null; largest: LargeFolder[] };
  connections: ConnectionUsage[];
};

/** One member on the admin page: their shard usage and quota. */
export type MemberUsage = { id: string; displayName: string; email?: string; role: 'admin' | 'member'; used: number; quota: number | null };
export type MemberUsageList = { items: MemberUsage[] };
