import { defineStore } from 'pinia';
import { DEFAULT_SORT, type Sort } from '@files/shared';
import { api } from '../api/client.ts';

/** The member's folder sort (#226), stored on the server so it follows them to every device and every source. */
export const useSortStore = defineStore('sort', {
  state: (): Sort => ({ ...DEFAULT_SORT }),
  actions: {
    /** Takes a sort the server confirmed (from /api/v1/me or a save). */
    apply(s: Sort) {
      this.key = s.key;
      this.dir = s.dir;
    },
    /** Saves and then applies; a refusal rejects with the ApiFailure and changes nothing, for the view to show. */
    async save(s: Sort) {
      this.apply(await api.put<Sort>('/api/v1/settings/sort', s));
    },
  },
});
