import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Access } from '@files/shared';
import { AppError } from '../errors.ts';
import { requireUser } from '../auth/guard.ts';
import { homeRoot } from '../paths.ts';
import { getUser, type User } from '../users.ts';
import type { StorageBackend } from './backend.ts';
import { LocalBackend } from './local.ts';
import { grantedShare, ShareBackend, type ShareRow } from './shares.ts';

export type { Access };
export type ResolvedSource = { backend: StorageBackend; access: Access };
export type SourceRef = { kind: 'home' } | { kind: 'conn'; id: string } | { kind: 'share'; id: string };

const REF_ID = /^[A-Za-z0-9_-]{1,64}$/;

// Exact grammar, no normalisation: anything else is unknown, never a fallback to home (#95).
export function parseSource(source: string): SourceRef {
  if (source === 'home') return { kind: 'home' };
  const m = /^(conn|share):(.*)$/.exec(source);
  if (m && REF_ID.test(m[2]!)) return { kind: m[1] as 'conn' | 'share', id: m[2]! };
  throw new AppError('SOURCE_NOT_FOUND');
}

// #148: the caller's own connection row only; another member's connection is SOURCE_NOT_FOUND.
async function resolveConnection(_user: User, _id: string): Promise<ResolvedSource> {
  throw new AppError('SOURCE_NOT_FOUND');
}

/** The home of `userId`, with that member's rows. Only the caller's home, or a share's owner's home, is ever built. */
function homeOf(deps: FastifyInstance['deps'], userId: string): LocalBackend {
  const { config, db, pathTables, trashTables, thumbs } = deps;
  return new LocalBackend(homeRoot(config.dataDir, userId), { db, userId, pathTables, trashTables, thumbs });
}

// The owner's own source behind a share, reached on the server: their home, or their cloud connection (#148). A
// connection the owner has unlinked leaves the share orphaned; it never falls back to another source (#95).
async function ownerSource(deps: FastifyInstance['deps'], row: ShareRow): Promise<StorageBackend> {
  if (row.source === 'home') return homeOf(deps, row.owner_id);
  const ref = parseSource(row.source);
  const owner = getUser(deps.db, row.owner_id);
  if (ref.kind !== 'conn' || !owner) throw new Error(`share ${row.id} has an invalid source ${row.source}`);
  const conn = (await deps.connections(owner)).find((c) => c.id === ref.id);
  if (!conn) throw new AppError('SHARE_ORPHANED');
  return conn.backend;
}

// #146: the share row granted to the caller, read again on every request; its access level comes from the row. A
// share of someone else, an unknown id and a revoked share are all SOURCE_NOT_FOUND; a deleted target is SHARE_ORPHANED.
async function resolveShare(req: FastifyRequest, user: User, id: string): Promise<ResolvedSource> {
  const deps = req.server.deps;
  const row = grantedShare(deps.db, id, user.id);
  if (!row) throw new AppError('SOURCE_NOT_FOUND');
  if (row.orphaned_at !== null) throw new AppError('SHARE_ORPHANED');
  return { backend: new ShareBackend(await ownerSource(deps, row), row.path), access: row.access };
}

/** The caller's own home. Used by `resolveSource` and by the trash routes, which exist only for the home. */
export function homeBackend(req: FastifyRequest): LocalBackend {
  const { user } = requireUser(req);
  return homeOf(req.server.deps, user.id);
}

/**
 * Every source the caller can search, home first: their home and each of their own cloud connections (#148 fills
 * `connections`). Sources shared with the caller are not searched (DECISIONS, #146).
 */
export async function searchableSources(req: FastifyRequest): Promise<{ source: string; backend: StorageBackend }[]> {
  const { user } = requireUser(req);
  const conns = await req.server.deps.connections(user);
  return [{ source: 'home', backend: homeBackend(req) }, ...conns.map((c) => ({ source: `conn:${c.id}`, backend: c.backend }))];
}

/** The one place a source id becomes a backend and the caller's access level. Routes never build a backend. */
export async function resolveSource(req: FastifyRequest, source: string): Promise<ResolvedSource> {
  const { user } = requireUser(req);
  const ref = parseSource(source);
  switch (ref.kind) {
    case 'home': return { backend: homeBackend(req), access: 'edit' };
    case 'conn': return resolveConnection(user, ref.id);
    case 'share': return resolveShare(req, user, ref.id);
  }
}
