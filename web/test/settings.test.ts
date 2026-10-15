import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { i18n } from '../src/i18n/index.ts';
import { themeFor } from '../src/theme.ts';
import { useSettingsStore } from '../src/stores/settings.ts';
import { ApiFailure } from '../src/api/client.ts';

// #159: the member's language and theme. A save applies only what the server confirmed; a refused one changes nothing.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  useSettingsStore().apply({ locale: 'de-du', theme: 'light' });
});
afterEach(() => vi.unstubAllGlobals());

describe('themeFor', () => {
  it('takes an explicit theme as it is', () => {
    expect(themeFor('light', true)).toBe('light');
    expect(themeFor('dark', false)).toBe('dark');
  });
  it('follows the system under "system"', () => {
    expect(themeFor('system', true)).toBe('dark');
    expect(themeFor('system', false)).toBe('light');
  });
});

describe('settings store', () => {
  it('applies a saved language and theme at once and remembers them on the device', async () => {
    const f = vi.fn(async (_u: string, init?: RequestInit) => json(JSON.parse(String(init!.body))));
    vi.stubGlobal('fetch', f);
    await useSettingsStore().save({ locale: 'en', theme: 'dark' });
    expect(f.mock.calls[0]![0]).toBe('/api/v1/settings');
    expect(f.mock.calls[0]![1]!.method).toBe('PUT');
    expect(i18n.global.locale.value).toBe('en');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(useSettingsStore().$state).toMatchObject({ locale: 'en', theme: 'dark' });
    expect(localStorage.getItem('files.locale')).toBe('en');
    expect(localStorage.getItem('files.theme')).toBe('dark');
  });

  it('a refused save rejects and leaves language, theme and the device cache as they were', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'INTERNAL' }, 500)));
    await expect(useSettingsStore().save({ locale: 'en', theme: 'dark' })).rejects.toBeInstanceOf(ApiFailure);
    expect(i18n.global.locale.value).toBe('de-du');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(useSettingsStore().$state).toMatchObject({ locale: 'de-du', theme: 'light' });
    expect(localStorage.getItem('files.locale')).toBe('de-du');
  });

  it('no language chosen falls back to the browser and clears the cached choice', () => {
    vi.stubGlobal('navigator', { ...navigator, languages: ['en-US'] });
    useSettingsStore().apply({ locale: null, theme: 'system' });
    expect(i18n.global.locale.value).toBe('en');
    expect(localStorage.getItem('files.locale')).toBeNull();
  });
});
