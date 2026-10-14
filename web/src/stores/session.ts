import { defineStore } from 'pinia';
import type { Me } from '@files/shared';
import { api, setCsrf } from '../api/client.ts';

export const useSessionStore = defineStore('session', {
  state: () => ({ me: null as Me | null }),
  actions: {
    async load() {
      const me = await api.get<Me>('/api/v1/me');
      setCsrf(me.csrfToken);
      this.me = me;
    },
  },
});
