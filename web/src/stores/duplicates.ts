import { defineStore } from 'pinia';
import type { DuplicateScan, TrashDuplicatesRequest, TrashDuplicatesResult } from '@files/shared';
import { api } from '../api/client.ts';

/** The member's duplicate scan (#216): its state from `/api/v1/duplicates`, start, cancel and moving picked copies to the trash. */
export const useDuplicatesStore = defineStore('duplicates', {
  state: () => ({ scan: null as DuplicateScan | null }),
  actions: {
    async load() { this.scan = await api.get<DuplicateScan>('/api/v1/duplicates'); },
    async start(sources: string[]) { this.scan = await api.post<DuplicateScan>('/api/v1/duplicates/scan', { sources }); },
    async cancel() { this.scan = await api.post<DuplicateScan>('/api/v1/duplicates/cancel', {}); },
    /** Each copy's outcome; the scan is loaded again, so trashed copies and resolved groups are gone from it. */
    async trash(items: TrashDuplicatesRequest['items']): Promise<TrashDuplicatesResult> {
      const r = await api.post<TrashDuplicatesResult>('/api/v1/duplicates/trash', { items });
      await this.load();
      return r;
    },
  },
});
