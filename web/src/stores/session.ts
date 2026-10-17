import { defineStore } from 'pinia';
import type { Me } from '@files/shared';
import { api, ApiFailure, setCsrf, signOutOfServer } from '../api/client.ts';
import { SIGNED_OUT_PATH } from '../api/paths.ts';
import { clearShares } from '../shareInbox.ts';
import { useSettingsStore } from './settings.ts';
import { useSortStore } from './sort.ts';
import { useLayoutStore } from './layout.ts';

export const useSessionStore = defineStore('session', {
  state: () => ({ me: null as Me | null, error: null as ApiFailure | null, signOutError: null as ApiFailure | null }),
  actions: {
    async load() {
      this.error = null;
      try {
        const me = await api.get<Me>('/api/v1/me');
        setCsrf(me.csrfToken);
        useSettingsStore().apply(me.settings); // the member's language and theme, on every device (#159)
        useSortStore().apply(me.sort); // and their folder sort (#226)
        useLayoutStore().apply(me.layout); // and their two panes and tabs (#218, #219)
        this.me = me;
      } catch (e) {
        if (!(e instanceof ApiFailure)) throw e;
        this.error = e;
      }
    },
    /**
     * Sign-out (#222): the session ends on the server, the browser forgets what it kept for the member (cached
     * preferences, resumable uploads, waiting shares), and a full load of the signed-out page drops every store.
     */
    async signOut() {
      this.signOutError = null;
      try { await signOutOfServer(); }
      catch (e) {
        if (!(e instanceof ApiFailure)) throw e;
        this.signOutError = e; // handled: the shell shows it; the member is still signed in and can try again
        return;
      }
      await clearShares();
      localStorage.clear();
      sessionStorage.clear();
      location.replace(SIGNED_OUT_PATH);
    },
  },
});
