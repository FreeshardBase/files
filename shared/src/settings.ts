import { z } from 'zod';

// A member's own settings (#159): the UI language and the theme, stored on the server so they follow the member.

/** The UI languages; each has its file `web/src/i18n/<tag>.json`. Adding a language adds its tag here. */
export const LOCALES = ['de-du', 'de-sie', 'en'] as const;
export const LocaleSchema = z.enum(LOCALES);
export type Locale = z.infer<typeof LocaleSchema>;

export const THEMES = ['light', 'dark', 'system'] as const;
export const ThemeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof ThemeSchema>;

/**
 * `GET`/`PUT /api/v1/settings`, and `settings` in `/api/v1/me`. `locale: null` means no language chosen: the client
 * resolves platform preference > browser > Deutsch (Du). A `PUT` replaces both fields.
 */
export const SettingsSchema = z.strictObject({ locale: LocaleSchema.nullable(), theme: ThemeSchema });
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = { locale: null, theme: 'system' };
