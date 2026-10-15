import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@files/shared';
import deDu from '../src/i18n/de-du.json';
import deSie from '../src/i18n/de-sie.json';
import en from '../src/i18n/en.json';
import { LOCALES, resolveLocale } from '../src/i18n/index.ts';

type Tree = { [k: string]: string | Tree };
const keys = (t: Tree, p = ''): string[] => Object.entries(t).flatMap(([k, v]) => typeof v === 'string' ? [p + k] : keys(v, p + k + '.'));
const values = (t: Tree): string[] => Object.values(t).flatMap((v) => typeof v === 'string' ? [v] : values(v));
const at = (t: Tree, key: string): string => key.split('.').reduce<string | Tree>((n, k) => (n as Tree)[k]!, t) as string;
// The language names of the settings page (#159) are proper names, the same in every file: "Deutsch (Sie)" is no
// address form. Only they are exempt from the address-form checks.
const NAME_PREFIX = 'settings.language.names.';
const addressed = (t: Tree): string[] => keys(t).filter((k) => !k.startsWith(NAME_PREFIX)).map((k) => at(t, k));

describe('locales', () => {
  it('every language has exactly the same keys', () => {
    const ref = keys(deDu as Tree).sort();
    expect(keys(deSie as Tree).sort()).toEqual(ref);
    expect(keys(en as Tree).sort()).toEqual(ref);
  });
  it('Deutsch (Du) never uses Sie-forms', () => {
    for (const v of addressed(deDu as Tree)) expect(v, v).not.toMatch(/\b(Sie|Ihnen|Ihr|Ihre|Ihren|Ihrem|Ihrer)\b/);
  });
  it('Deutsch (Sie) never uses Du-forms', () => {
    for (const v of addressed(deSie as Tree)) expect(v, v).not.toMatch(/\b(du|dich|dir|dein|deine|deinen|deinem|deiner|Du|Dich|Dir|Dein|Deine)\b/);
  });
  it('names every language in itself, the same in every file, and nothing else is exempt from the address checks', () => {
    expect(LOCALES.map((l) => at(en as Tree, NAME_PREFIX + l))).toEqual(['Deutsch (Du)', 'Deutsch (Sie)', 'English']);
    for (const t of [deDu, deSie]) for (const l of LOCALES) expect(at(t as Tree, NAME_PREFIX + l)).toBe(at(en as Tree, NAME_PREFIX + l));
    expect(keys(deDu as Tree).filter((k) => k.startsWith(NAME_PREFIX)).sort()).toEqual(LOCALES.map((l) => NAME_PREFIX + l).sort());
  });
  it('no value is empty', () => {
    for (const t of [deDu, deSie, en]) for (const v of values(t as Tree)) expect(v.trim()).not.toBe('');
  });
  it('every shared ErrorCode has an errors.<code> message in every language', () => {
    for (const [name, t] of [['de-du', deDu], ['de-sie', deSie], ['en', en]] as const) {
      const have = new Set(keys(t as Tree));
      for (const code of ERROR_CODES) expect(have.has(`errors.${code}`), `${name} lacks errors.${code}`).toBe(true);
    }
  });
});

describe('resolveLocale', () => {
  it('prefers the stored setting', () => expect(resolveLocale('en', ['de-DE'])).toBe('en'));
  it('maps a German browser to de-du', () => expect(resolveLocale(null, ['de-AT', 'en'])).toBe('de-du'));
  it('maps an English browser to en', () => expect(resolveLocale(null, ['en-GB'])).toBe('en'));
  it('falls back to de-du', () => expect(resolveLocale(null, ['fr-FR'])).toBe('de-du'));
  it('ignores an unknown stored value', () => expect(resolveLocale('xx', ['en-US'])).toBe('en'));
});
