import { describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import { htmlLangFor, syncHtmlLang } from '../src/i18n/htmlLang.ts';

describe('html lang sync', () => {
  it('maps both German variants to de and English to en', () => {
    expect(htmlLangFor('de-du')).toBe('de');
    expect(htmlLangFor('de-sie')).toBe('de');
    expect(htmlLangFor('en')).toBe('en');
  });
  it('sets lang on startup and follows locale changes', async () => {
    const locale = ref('en');
    const h = syncHtmlLang(locale);
    expect(document.documentElement.lang).toBe('en');
    locale.value = 'de-sie';
    await nextTick();
    expect(document.documentElement.lang).toBe('de');
    h.stop();
  });
});
