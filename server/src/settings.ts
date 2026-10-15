import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from '@files/shared';
import type { Db } from './db.ts';

/** A member's settings (#159); the defaults until their first save. A row that breaks the schema fails loudly. */
export function settingsOf(db: Db, userId: string): Settings {
  const row = db.prepare('SELECT locale, theme FROM user_settings WHERE user_id = ?').get(userId) as
    { locale: string | null; theme: string } | undefined;
  return row ? SettingsSchema.parse(row) : DEFAULT_SETTINGS;
}

/** Replaces the member's settings in one statement. */
export function saveSettings(db: Db, userId: string, s: Settings): Settings {
  db.prepare(`INSERT INTO user_settings (user_id, locale, theme, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET locale = excluded.locale, theme = excluded.theme, updated_at = excluded.updated_at`)
    .run(userId, s.locale, s.theme, new Date().toISOString());
  return settingsOf(db, userId);
}
