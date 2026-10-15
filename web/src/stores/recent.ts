import { defineStore } from 'pinia';
import type { RecentItem, RecentList } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';

export const useRecentStore = defineStore('recent', {
  state: () => ({
    items: [] as RecentItem[],
    loaded: false, // the first list has arrived; until then the view shows a placeholder
    error: null as ApiFailure | null,
    seq: 0, // request token: only the newest load() may touch state
  }),
  actions: {
    async load() {
      const id = ++this.seq;
      this.error = null;
      try {
        const r = await api.get<RecentList>('/api/v1/recent');
        if (id !== this.seq) return;
        this.items = r.items;
      } catch (e) {
        if (id !== this.seq) return;
        if (!(e instanceof ApiFailure)) throw e;
        this.error = e; this.items = [];
      } finally {
        if (id === this.seq) this.loaded = true;
      }
    },
  },
});
