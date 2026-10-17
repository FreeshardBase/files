import { defineStore } from 'pinia';
import type { FileRequest, FileRequestList } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';

/** The member's file requests (#217), for the "File requests" page and the sidebar's badge of new files. */
export const useRequestsStore = defineStore('requests', {
  state: () => ({
    items: [] as FileRequest[],
    loaded: false,
    error: null as ApiFailure | null,
    seq: 0, // request token: only the newest load() may touch state
  }),
  getters: {
    /** Files received through any request that the member has not looked at yet. */
    newFiles: (s) => s.items.reduce((n, r) => n + r.newFiles, 0),
  },
  actions: {
    async load(): Promise<void> {
      const id = ++this.seq;
      try {
        const r = await api.get<FileRequestList>('/api/v1/requests');
        if (id !== this.seq) return;
        this.items = r.items; this.error = null;
      } catch (e) {
        if (id !== this.seq) return;
        if (!(e instanceof ApiFailure)) throw e;
        this.error = e;
      } finally {
        if (id === this.seq) this.loaded = true;
      }
    },
  },
});
