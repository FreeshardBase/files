import { z } from 'zod';

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
const issuerUrl = z.url().transform((s) => new URL(s)).refine(
  (u) => u.protocol === 'https:' || (u.protocol === 'http:' && loopback.has(u.hostname)),
  'must be https (http only for loopback)',
);

const Schema = z.object({
  FILES_PUBLIC_URL: z.url().transform((s) => new URL(s)),
  FILES_DATA_DIR: z.string().min(1),
  FILES_SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  FILES_ENCRYPTION_KEY: z.string().transform((s) => Buffer.from(s, 'base64'))
    .refine((b) => b.length === 32, 'must be 32 bytes, base64-encoded'),
  FILES_OIDC_ISSUER: issuerUrl,
  FILES_OIDC_CLIENT_ID: z.string().min(1),
  FILES_OIDC_CLIENT_SECRET: z.string().min(1),
  FILES_OIDC_ROLE_CLAIM: z.string().min(1),
  FILES_OIDC_ADMIN_VALUE: z.string().min(1),
  FILES_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 ** 3),
  FILES_PORT: z.coerce.number().int().min(0).max(65535).default(3005),
  FILES_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
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
      clientSecret: e.FILES_OIDC_CLIENT_SECRET, roleClaim: e.FILES_OIDC_ROLE_CLAIM,
      adminValue: e.FILES_OIDC_ADMIN_VALUE,
    },
    maxUploadBytes: e.FILES_MAX_UPLOAD_BYTES,
    port: e.FILES_PORT,
    logLevel: e.FILES_LOG_LEVEL,
  };
}
