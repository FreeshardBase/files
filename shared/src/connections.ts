import { z } from 'zod';

/** A connection id: 16 random bytes as hex. The member addresses the connection's files as the source `conn:<id>`. */
export const ConnectionId = z.string().regex(/^[0-9a-f]{32}$/);

/** A provider id from the server's provider list (`google`, `dropbox`, `graph` with #149–#151). */
export const ProviderId = z.string().regex(/^[a-z0-9-]{1,32}$/);

/**
 * `ok`: the tokens work. `reauth`: the provider refused the refresh token (revoked or expired consent); the member signs
 * in again. `unavailable`: the shard no longer offers this provider (its client credentials were removed).
 */
export const ConnectionStatus = z.enum(['ok', 'reauth', 'unavailable']);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const ConnectionSchema = z.object({
  id: ConnectionId,
  /** `conn:<id>`, the source of its files. */
  source: z.string(),
  provider: z.string(),
  /** The provider's own name (a brand, not translated). */
  providerName: z.string(),
  /** The provider account, as the provider names it (usually its e-mail address). */
  account: z.string(),
  status: ConnectionStatus,
  createdAt: z.iso.datetime(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export const ProviderInfoSchema = z.object({ id: ProviderId, name: z.string() });
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

/** The caller's own connections, and the providers this shard offers for a new one. */
export const ConnectionListSchema = z.object({ items: z.array(ConnectionSchema), providers: z.array(ProviderInfoSchema) });
export type ConnectionList = z.infer<typeof ConnectionListSchema>;

/** Body of `connections/authorize`: connect a new account of a provider, or sign in again to an existing connection. */
export const AuthorizeRequest = z.union([
  z.strictObject({ provider: ProviderId }),
  z.strictObject({ connection: ConnectionId }),
]);
export type AuthorizeRequest = z.infer<typeof AuthorizeRequest>;

/** Where the browser goes next: the provider's consent page. */
export type AuthorizeResponse = { url: string };
