import type { FastifyInstance } from 'fastify';
import { SettingsSchema, SortSchema, type Settings, type Sort } from '@files/shared';
import { requireUser } from '../auth/guard.ts';
import { saveSettings, saveSort, settingsOf, sortOf } from '../settings.ts';

/** `/api/v1/settings` (#159): the caller's own language and theme; session and CSRF like every route. */
export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get('/api/v1/settings', async (req): Promise<Settings> => settingsOf(db, requireUser(req).user.id));

  app.put('/api/v1/settings', async (req): Promise<Settings> => {
    const { user } = requireUser(req);
    return saveSettings(db, user.id, SettingsSchema.parse(req.body));
  });

  // The folder sort (#226): a resource of its own, so a sort change never races a language or theme save.
  app.get('/api/v1/settings/sort', async (req): Promise<Sort> => sortOf(db, requireUser(req).user.id));

  app.put('/api/v1/settings/sort', async (req): Promise<Sort> => {
    const { user } = requireUser(req);
    return saveSort(db, user.id, SortSchema.parse(req.body));
  });
}
