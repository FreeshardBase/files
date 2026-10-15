import { createI18n } from 'vue-i18n';
import { LOCALES, type Locale } from '@files/shared';
import deDu from './de-du.json';
import deSie from './de-sie.json';
import en from './en.json';

export { LOCALES, type Locale };
const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

// Resolution order (spec §2.1): the member's setting > platform preference (freeshard#168, not there yet) > browser >
// Deutsch (Du).
export function resolveLocale(setting: string | null, browser: readonly string[]): Locale {
  if (isLocale(setting)) return setting;
  for (const b of browser) {
    const lang = b.toLowerCase().split('-')[0];
    if (lang === 'de') return 'de-du';
    if (lang === 'en') return 'en';
  }
  return 'de-du';
}

const browserLanguages = (): readonly string[] => navigator.languages ?? [navigator.language];

// The device keeps the member's last known choice, so the first paint (and a public link's page, which never asks the
// server) is already in that language; the server's setting replaces it as soon as /api/v1/me answers.
const CACHE_KEY = 'files.locale';
function storedLocale(): string | null {
  try { return localStorage.getItem(CACHE_KEY); }
  catch { return null; } // handled: storage blocked (private mode) → fall back to browser languages
}
function rememberLocale(setting: Locale | null) {
  try { if (setting) localStorage.setItem(CACHE_KEY, setting); else localStorage.removeItem(CACHE_KEY); }
  catch { /* handled: storage blocked → the next start takes the browser language until /api/v1/me answers */ }
}

export const i18n = createI18n({
  legacy: false,
  locale: resolveLocale(storedLocale(), browserLanguages()),
  fallbackLocale: 'de-du',
  messages: { 'de-du': deDu, 'de-sie': deSie, en },
});

/** Switches the UI to the member's setting (null: no choice, the browser decides) and remembers it on the device. */
export function applyLocale(setting: Locale | null) {
  i18n.global.locale.value = resolveLocale(setting, browserLanguages());
  rememberLocale(setting);
}
