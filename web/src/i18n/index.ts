import { createI18n } from 'vue-i18n';
import deDu from './de-du.json';
import deSie from './de-sie.json';
import en from './en.json';

export const LOCALES = ['de-du', 'de-sie', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

export function resolveLocale(stored: string | null, browser: readonly string[]): Locale {
  if (isLocale(stored)) return stored;
  for (const b of browser) {
    const lang = b.toLowerCase().split('-')[0];
    if (lang === 'de') return 'de-du';
    if (lang === 'en') return 'en';
  }
  return 'de-du';
}

function storedLocale(): string | null {
  try { return localStorage.getItem('files.locale'); }
  catch { return null; } // handled: storage blocked (private mode) → fall back to browser languages
}

export const i18n = createI18n({
  legacy: false,
  locale: resolveLocale(storedLocale(), navigator.languages ?? [navigator.language]),
  fallbackLocale: 'de-du',
  messages: { 'de-du': deDu, 'de-sie': deSie, en },
});
