import { DEFAULT_SETTINGS, DEFAULT_SORT, SettingsSchema, SortSchema, type Settings, type Sort } from '@files/shared';
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

/** A member's folder sort (#226); name ascending until their first change. */
export function sortOf(db: Db, userId: string): Sort {
  const row = db.prepare('SELECT sort_key AS key, sort_dir AS dir FROM user_settings WHERE user_id = ?').get(userId) as
    { key: string; dir: string } | undefined;
  return row ? SortSchema.parse(row) : DEFAULT_SORT;
}

/** Replaces the member's sort; language and theme stay as they are (the defaults on a new row). */
export function saveSort(db: Db, userId: string, s: Sort): Sort {
  db.prepare(`INSERT INTO user_settings (user_id, locale, theme, sort_key, sort_dir, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET sort_key = excluded.sort_key, sort_dir = excluded.sort_dir, updated_at = excluded.updated_at`)
    .run(userId, DEFAULT_SETTINGS.locale, DEFAULT_SETTINGS.theme, s.key, s.dir, new Date().toISOString());
  return sortOf(db, userId);
}
