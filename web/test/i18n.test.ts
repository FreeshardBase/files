import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@files/shared';
import deDu from '../src/i18n/de-du.json';
import deSie from '../src/i18n/de-sie.json';
import en from '../src/i18n/en.json';
import { resolveLocale } from '../src/i18n/index.ts';

type Tree = { [k: string]: string | Tree };
const keys = (t: Tree, p = ''): string[] => Object.entries(t).flatMap(([k, v]) => typeof v === 'string' ? [p + k] : keys(v, p + k + '.'));
const values = (t: Tree): string[] => Object.values(t).flatMap((v) => typeof v === 'string' ? [v] : values(v));

describe('locales', () => {
  it('every language has exactly the same keys', () => {
    const ref = keys(deDu as Tree).sort();
    expect(keys(deSie as Tree).sort()).toEqual(ref);
    expect(keys(en as Tree).sort()).toEqual(ref);
  });
  it('Deutsch (Du) never uses Sie-forms', () => {
    for (const v of values(deDu as Tree)) expect(v, v).not.toMatch(/\b(Sie|Ihnen|Ihr|Ihre|Ihren|Ihrem|Ihrer)\b/);
  });
  it('Deutsch (Sie) never uses Du-forms', () => {
    for (const v of values(deSie as Tree)) expect(v, v).not.toMatch(/\b(du|dich|dir|dein|deine|deinen|deinem|deiner|Du|Dich|Dir|Dein|Deine)\b/);
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
