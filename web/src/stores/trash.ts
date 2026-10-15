import { defineStore } from 'pinia';
import type { CollisionPolicy, Entry, PurgeRequest, RestoreRequest, TrashItem, TrashList } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';

const BASE = '/api/v1/trash';

export const useTrashStore = defineStore('trash', {
  state: () => ({
    items: [] as TrashItem[], totalSize: 0, retentionDays: 0,
    loaded: false, // the first list has arrived; until then the view shows a placeholder
    error: null as ApiFailure | null,
    seq: 0, // request token: only the newest load() may touch state
  }),
  actions: {
    async load() {
      const id = ++this.seq;
      this.error = null;
      try {
        const r = await api.get<TrashList>(BASE);
        if (id !== this.seq) return;
        this.items = r.items; this.totalSize = r.totalSize; this.retentionDays = r.retentionDays;
      } catch (e) {
        if (id !== this.seq) return;
        if (!(e instanceof ApiFailure)) throw e;
        this.error = e; this.items = [];
      } finally {
        if (id === this.seq) this.loaded = true;
      }
    },
    /** Back to its original path; a taken name answers FILE_EXISTS for `fail`. The caller reloads. */
    restore(id: string, onCollision: CollisionPolicy): Promise<Entry> {
      return api.post<Entry>(`${BASE}/restore`, { id, onCollision } satisfies RestoreRequest);
    },
    /** Deletes the items permanently. The caller reloads. */
    async purge(ids: string[]): Promise<void> {
      await api.post(`${BASE}/delete`, { ids } satisfies PurgeRequest);
    },
    async empty(): Promise<void> {
      await api.post(`${BASE}/empty`, {});
    },
  },
});
