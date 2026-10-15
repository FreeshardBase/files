import { defineStore } from 'pinia';
import type { SearchGroup, SearchResponse } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';

export const useSearchStore = defineStore('search', {
  state: () => ({
    query: '', // the query `groups` belong to
    groups: [] as SearchGroup[],
    loading: false,
    error: null as ApiFailure | null, // the whole request failed; a single source's failure is in its group
    seq: 0, // request token: only the newest search() may touch state
  }),
  actions: {
    async search(q: string) {
      const id = ++this.seq;
      this.loading = true; this.error = null;
      try {
        const r = await api.get<SearchResponse>('/api/v1/search', { q });
        if (id !== this.seq) return;
        this.groups = r.groups; this.query = q;
      } catch (e) {
        if (id !== this.seq) return;
        if (!(e instanceof ApiFailure)) throw e;
        this.error = e; this.groups = []; this.query = q;
      } finally {
        if (id === this.seq) this.loading = false;
      }
    },
    clear() {
      this.seq++;
      this.query = ''; this.groups = []; this.loading = false; this.error = null;
    },
  },
});
