import { defineStore } from 'pinia';
import type { IncomingShare, IncomingShareList } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';

/** "Shared with me" (#146): what other members shared with the caller. */
export const useSharedStore = defineStore('shared', {
  state: () => ({
    items: [] as IncomingShare[],
    loaded: false, // the first list has arrived; until then the view shows a placeholder
    error: null as ApiFailure | null,
    seq: 0, // request token: only the newest load() may touch state
  }),
  actions: {
    async load() {
      const id = ++this.seq;
      this.error = null;
      try {
        const r = await api.get<IncomingShareList>('/api/v1/shares/incoming');
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
    /** Removes a share from the list (the grantee leaves it); the caller reports a failure. */
    async remove(id: string) {
      await api.delete(`/api/v1/shares/${encodeURIComponent(id)}`);
      await this.load();
    },
  },
});
