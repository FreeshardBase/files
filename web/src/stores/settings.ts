import { defineStore } from 'pinia';
import { DEFAULT_SETTINGS, type Settings } from '@files/shared';
import { api } from '../api/client.ts';
import { applyLocale } from '../i18n/index.ts';
import { applyTheme } from '../theme.ts';

/** The member's language and theme (#159), stored on the server so they follow the member to every device. */
export const useSettingsStore = defineStore('settings', {
  state: (): Settings => ({ ...DEFAULT_SETTINGS }),
  actions: {
    /** Takes settings the server confirmed (from /api/v1/me or a save) and applies them to the whole app. */
    apply(s: Settings) {
      this.locale = s.locale;
      this.theme = s.theme;
      applyLocale(s.locale);
      applyTheme(s.theme);
    },
    /** Saves and then applies; a refusal rejects with the ApiFailure and changes nothing, for the view to show. */
    async save(s: Settings) {
      this.apply(await api.put<Settings>('/api/v1/settings', s));
    },
  },
});
