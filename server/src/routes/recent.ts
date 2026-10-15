import type { FastifyInstance } from 'fastify';
import type { RecentList } from '@files/shared';
import { requireUser } from '../auth/guard.ts';
import { recentItems } from '../storage/recent.ts';

// The caller's own recent items. Only the home records them today; cloud sources add theirs later (#149–#151).
export async function registerRecentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/recent', async (req): Promise<RecentList> => {
    const { user } = requireUser(req);
    return { items: recentItems(app.deps.db, user.id) };
  });
}
