import { defineStore } from 'pinia';
import type { Me } from '@files/shared';
import { api, ApiFailure, setCsrf } from '../api/client.ts';

export const useSessionStore = defineStore('session', {
  state: () => ({ me: null as Me | null, error: null as ApiFailure | null }),
  actions: {
    async load() {
      this.error = null;
      try {
        const me = await api.get<Me>('/api/v1/me');
        setCsrf(me.csrfToken);
        this.me = me;
      } catch (e) {
        if (!(e instanceof ApiFailure)) throw e;
        this.error = e;
      }
    },
  },
});
