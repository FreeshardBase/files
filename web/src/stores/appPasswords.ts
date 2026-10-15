import { defineStore } from 'pinia';
import type { AppPassword, AppPasswordList, CreatedAppPassword } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';

/** The member's app passwords for WebDAV (#157). The password itself is only in `create`'s answer, never in the list. */
export const useAppPasswordsStore = defineStore('appPasswords', {
  state: () => ({
    items: [] as AppPassword[],
    loaded: false,
    error: null as ApiFailure | null,
    seq: 0, // only the newest load() may touch state
  }),
  actions: {
    async load() {
      const id = ++this.seq;
      this.error = null;
      try {
        const r = await api.get<AppPasswordList>('/api/v1/app-passwords');
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
    /** Creates one; a refusal (the limit, a bad label) rejects with the ApiFailure for the view to show. */
    async create(label: string): Promise<CreatedAppPassword> {
      const r = await api.post<CreatedAppPassword>('/api/v1/app-passwords', { label });
      this.items = [...this.items, r.item];
      return r;
    },
    async revoke(id: string) {
      await api.delete(`/api/v1/app-passwords/${encodeURIComponent(id)}`);
      this.items = this.items.filter((i) => i.id !== id);
    },
  },
});
