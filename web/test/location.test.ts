import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { defineComponent, h } from 'vue';
import en from '../src/i18n/en.json';
import deDu from '../src/i18n/de-du.json';
import { joinLocation, parentOf, useLocations } from '../src/location.ts';
import { useConnectionsStore } from '../src/stores/connections.ts';

// #244: a folder's location is written one way everywhere: the root's name, then the folders, joined by " › ".
describe('folder locations', () => {
  it('join the root name and the folders, never with a slash', () => {
    expect(joinLocation('My storage', '/')).toBe('My storage');
    expect(joinLocation('My storage', '/Projects')).toBe('My storage › Projects');
    expect(joinLocation('Dropbox', '/Reports/2026/')).toBe('Dropbox › Reports › 2026');
    expect(parentOf('/Projects/plan.txt')).toBe('/Projects');
    expect(parentOf('/plan.txt')).toBe('/');
  });

  it('name the home, a cloud by its provider alone, and a share', () => {
    setActivePinia(createPinia());
    const connections = useConnectionsStore();
    connections.items = [{ id: 'abc', source: 'conn:abc', provider: 'dropbox', providerName: 'Dropbox', account: 'testuser@example.com',
      status: 'ok' } as never];
    let api!: ReturnType<typeof useLocations>;
    const i18n = createI18n({ legacy: false, locale: 'de-du', messages: { en, 'de-du': deDu } });
    mount(defineComponent({ setup: () => { api = useLocations(); return () => h('div'); } }), { global: { plugins: [i18n] } });
    expect(api.folderLabel('home', '/Projekte')).toBe('Mein Speicher › Projekte');
    expect(api.folderLabel('home', '/')).toBe('Mein Speicher');
    expect(api.folderLabel('conn:abc', '/Reports')).toBe('Dropbox › Reports');
    expect(api.sourceName('conn:abc')).toBe('Dropbox');
    expect(api.sourceAccount('conn:abc')).toBe('testuser@example.com');
    expect(api.sourceAccount('home')).toBeNull();
    expect(api.folderLabel('share:xyz', '/Fotos')).toBe('Für mich freigegeben › Fotos');
  });
});
