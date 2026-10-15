import { z } from 'zod';

/** A connection id: 16 random bytes as hex. The member addresses the connection's files as the source `conn:<id>`. */
export const ConnectionId = z.string().regex(/^[0-9a-f]{32}$/);

/** A provider id from the server's provider list (`google`, `dropbox`, `graph` with #149–#151). */
export const ProviderId = z.string().regex(/^[a-z0-9-]{1,32}$/);

/**
 * `ok`: the tokens work. `reauth`: the provider refused the refresh token (revoked or expired consent); the member signs
 * in again. `unavailable`: the shard no longer offers this provider (its client credentials were removed). `library`: a
 * SharePoint connection whose document library the member has not picked yet (#151); it shows no files until then.
 */
export const ConnectionStatus = z.enum(['ok', 'reauth', 'unavailable', 'library']);
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
  /** The picked document library of a SharePoint connection, as "Site / Library" (#151). */
  library: z.string().optional(),
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

/** A SharePoint site or library id as Graph issues it (`host,guid,guid`; `b!…`): bounded, URL-safe characters only. */
export const GraphId = z.string().regex(/^[A-Za-z0-9!.,_-]{1,512}$/);

/** A SharePoint site the member can reach, for the library picker (#151). `url` is shown as text only. */
export type Site = { id: string; name: string; url: string };
/** A document library of a site. */
export type Library = { id: string; name: string };
export type SiteList = { items: Site[] };
export type LibraryList = { items: Library[] };

/** Body of `connections/:id/library`: the library a pending SharePoint connection shows from then on. */
export const PickLibraryRequest = z.strictObject({ site: GraphId, library: GraphId });
export type PickLibraryRequest = z.infer<typeof PickLibraryRequest>;
