import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors.ts';
import { requireUser } from '../auth/guard.ts';
import { homeRoot } from '../paths.ts';
import type { User } from '../users.ts';
import type { StorageBackend } from './backend.ts';
import { LocalBackend } from './local.ts';

export type Access = 'read' | 'edit';
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

// #146: the share row granted to the caller, re-checked on every access; its access level comes from the row.
async function resolveShare(_user: User, _id: string): Promise<ResolvedSource> {
  throw new AppError('SOURCE_NOT_FOUND');
}

/** The caller's own home. Used by `resolveSource` and by the trash routes, which exist only for the home. */
export function homeBackend(req: FastifyRequest): LocalBackend {
  const { user } = requireUser(req);
  const { config, db, pathTables, trashTables, thumbs } = req.server.deps;
  return new LocalBackend(homeRoot(config.dataDir, user.id), { db, userId: user.id, pathTables, trashTables, thumbs });
}

/** The one place a source id becomes a backend and the caller's access level. Routes never build a backend. */
export async function resolveSource(req: FastifyRequest, source: string): Promise<ResolvedSource> {
  const { user } = requireUser(req);
  const ref = parseSource(source);
  switch (ref.kind) {
    case 'home': return { backend: homeBackend(req), access: 'edit' };
    case 'conn': return resolveConnection(user, ref.id);
    case 'share': return resolveShare(user, ref.id);
  }
}
