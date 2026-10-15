import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { errorStatus, MemberId, SetQuotaRequest, type ConnectionUsage, type MemberUsage, type MemberUsageList,
  type StorageOverview } from '@files/shared';
import { requireAdmin, requireUser } from '../auth/guard.ts';
import { AppError } from '../errors.ts';
import { homeBackend, homeOf } from '../storage/resolveSource.ts';

/** How many of the largest folders the overview lists. */
export const LARGEST_FOLDERS = 10;

type MemberRow = { id: string; displayName: string; email: string | null; role: 'admin' | 'member'; quota: number | null };
const MEMBERS = 'SELECT id, display_name AS displayName, email, role, quota_bytes AS quota FROM users';

// The storage overview (#156): the caller's own usage per source, and the admin's page of members and their quotas.
// Only the admin (role from the OIDC claim) reads another member's usage or sets a quota; everyone else gets FORBIDDEN.
export async function registerStorageRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  // Every connection is asked at once; one that fails is reported with its error code (logged when unexpected), and
  // the home and the other connections still answer.
  app.get('/api/v1/storage', async (req): Promise<StorageOverview> => {
    const { user } = requireUser(req);
    const home = homeBackend(req);
    const connections = await Promise.all((await app.deps.connections(user)).map(async ({ id, backend }): Promise<ConnectionUsage> => {
      const source = `conn:${id}`;
      if (!backend.quota) return { source, error: { code: 'NOT_SUPPORTED' } };
      try {
        const q = await backend.quota();
        if (q === null) return { source, quota: null };
        return { source, quota: { used: q.used, ...(q.total !== undefined ? { total: q.total } : {}) } };
      } catch (e) { // handled: reported as this connection's error code next to the other sources; logged if unexpected
        const code = e instanceof AppError ? e.code : 'PROVIDER_UNAVAILABLE';
        if (!(e instanceof AppError) || errorStatus[code] >= 500) req.log.error({ err: e, source }, 'provider quota failed');
        return { source, error: { code } };
      }
    }));
    return { home: { usage: await home.usage(), quota: home.quotaBytes(), largest: home.largestFolders(LARGEST_FOLDERS) }, connections };
  });

  const view = async (r: MemberRow): Promise<MemberUsage> => ({
    id: r.id, displayName: r.displayName, ...(r.email ? { email: r.email } : {}), role: r.role,
    used: (await homeOf(app.deps, r.id).usage()).total, quota: r.quota,
  });

  // Members are everyone who has signed in to Files once, the admin included.
  app.get('/api/v1/admin/members', async (req): Promise<MemberUsageList> => {
    requireAdmin(req);
    const rows = db.prepare(`${MEMBERS} ORDER BY display_name COLLATE NOCASE, id`).all() as MemberRow[];
    return { items: await Promise.all(rows.map(view)) };
  });

  // A new quota applies to the next upload, copy, restore or transfer item; nothing already stored is removed.
  app.put('/api/v1/admin/members/:id/quota', async (req): Promise<MemberUsage> => {
    requireAdmin(req);
    const { id } = z.object({ id: MemberId }).parse(req.params);
    const { quotaBytes } = SetQuotaRequest.parse(req.body);
    if (db.prepare('UPDATE users SET quota_bytes = ? WHERE id = ?').run(quotaBytes, id).changes === 0) throw new AppError('NOT_FOUND');
    return view(db.prepare(`${MEMBERS} WHERE id = ?`).get(id) as MemberRow);
  });
}
