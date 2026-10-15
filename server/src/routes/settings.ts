import type { FastifyInstance } from 'fastify';
import { SettingsSchema, type Settings } from '@files/shared';
import { requireUser } from '../auth/guard.ts';
import { saveSettings, settingsOf } from '../settings.ts';

/** `/api/v1/settings` (#159): the caller's own language and theme; session and CSRF like every route. */
export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;

  app.get('/api/v1/settings', async (req): Promise<Settings> => settingsOf(db, requireUser(req).user.id));

  app.put('/api/v1/settings', async (req): Promise<Settings> => {
    const { user } = requireUser(req);
    return saveSettings(db, user.id, SettingsSchema.parse(req.body));
  });
}
