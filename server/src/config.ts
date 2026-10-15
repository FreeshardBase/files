import { hkdfSync } from 'node:crypto';
import { z } from 'zod';

// The shard's app template only provides `{{ secret('…') }}` (32 alphanumeric characters), so the
// AES-256 key is derived from the secret. Salt and info are fixed: changing them orphans encrypted data.
const ENCRYPTION_KEY_SALT = 'freeshard-files';
const ENCRYPTION_KEY_INFO = 'files/encryption-key/v1';
const deriveEncryptionKey = (secret: string) =>
  Buffer.from(hkdfSync('sha256', secret, ENCRYPTION_KEY_SALT, ENCRYPTION_KEY_INFO, 32));

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
const secureOrLoopback = (u: URL) => u.protocol === 'https:' || (u.protocol === 'http:' && loopback.has(u.hostname));
const issuerUrl = z.url().transform((s) => new URL(s)).refine(secureOrLoopback, 'must be https (http only for loopback)');
// The public URL is an origin: cookies, CSRF and redirects are built from it, so no path, query or fragment.
const publicUrl = z.url()
  .refine((s) => !/[?#]/.test(s), 'must not have a query or fragment')
  .transform((s) => new URL(s))
  .refine(secureOrLoopback, 'must be https (http only for loopback)')
  .refine((u) => u.pathname === '/', 'must not have a path');

const Schema = z.object({
  FILES_PUBLIC_URL: publicUrl,
  FILES_DATA_DIR: z.string().min(1),
  FILES_SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  FILES_ENCRYPTION_KEY: z.string()
    .min(32, 'must be at least 32 characters')
    .transform(deriveEncryptionKey),
  FILES_OIDC_ISSUER: issuerUrl,
  FILES_OIDC_CLIENT_ID: z.string().min(1),
  FILES_OIDC_CLIENT_SECRET: z.string().min(1),
  // Optional as a pair: shard_core sends no role claim yet (freeshard#251). Without them nobody is admin.
  FILES_OIDC_ROLE_CLAIM: z.string().min(1).optional(),
  FILES_OIDC_ADMIN_VALUE: z.string().min(1).optional(),
  FILES_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 ** 3),
  // Days an item stays in the trash before the expiry job deletes it permanently.
  FILES_TRASH_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  // The thumbnail cache's size cap (the least recently used thumbnails go first) and each generator's time limit.
  FILES_THUMB_CACHE_BYTES: z.coerce.number().int().positive().default(512 * 1024 ** 2),
  FILES_THUMB_TIMEOUT_MS: z.coerce.number().int().min(1).max(600_000).default(30_000),
  FILES_PORT: z.coerce.number().int().min(0).max(65535).default(3005),
  FILES_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
  // The shard's OAuth client at Google (#149). Optional as a pair: without it Google Drive is not offered.
  FILES_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  FILES_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
}).refine((e) => (e.FILES_OIDC_ROLE_CLAIM === undefined) === (e.FILES_OIDC_ADMIN_VALUE === undefined), {
  path: ['FILES_OIDC_ROLE_CLAIM'],
  message: 'FILES_OIDC_ROLE_CLAIM and FILES_OIDC_ADMIN_VALUE must be set both or neither',
}).refine((e) => (e.FILES_GOOGLE_CLIENT_ID === undefined) === (e.FILES_GOOGLE_CLIENT_SECRET === undefined), {
  path: ['FILES_GOOGLE_CLIENT_ID'],
  message: 'FILES_GOOGLE_CLIENT_ID and FILES_GOOGLE_CLIENT_SECRET must be set both or neither',
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined>) {
  const r = Schema.safeParse(env);
  if (!r.success) {
    throw new ConfigError(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = r.data;
  return {
    publicUrl: e.FILES_PUBLIC_URL,
    dataDir: e.FILES_DATA_DIR,
    sessionSecret: e.FILES_SESSION_SECRET,
    encryptionKey: e.FILES_ENCRYPTION_KEY,
    oidc: {
      issuer: e.FILES_OIDC_ISSUER, clientId: e.FILES_OIDC_CLIENT_ID,
      clientSecret: e.FILES_OIDC_CLIENT_SECRET,
      admin: e.FILES_OIDC_ROLE_CLAIM !== undefined && e.FILES_OIDC_ADMIN_VALUE !== undefined
        ? { claim: e.FILES_OIDC_ROLE_CLAIM, value: e.FILES_OIDC_ADMIN_VALUE }
        : undefined,
    },
    maxUploadBytes: e.FILES_MAX_UPLOAD_BYTES,
    trashRetentionDays: e.FILES_TRASH_RETENTION_DAYS,
    thumbCacheBytes: e.FILES_THUMB_CACHE_BYTES,
    thumbTimeoutMs: e.FILES_THUMB_TIMEOUT_MS,
    port: e.FILES_PORT,
    logLevel: e.FILES_LOG_LEVEL,
    google: e.FILES_GOOGLE_CLIENT_ID !== undefined && e.FILES_GOOGLE_CLIENT_SECRET !== undefined
      ? { clientId: e.FILES_GOOGLE_CLIENT_ID, clientSecret: e.FILES_GOOGLE_CLIENT_SECRET }
      : undefined,
  };
}
