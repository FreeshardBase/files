import { defineStore } from 'pinia';
import { DEFAULT_LAYOUT, type Layout } from '@files/shared';
import { api } from '../api/client.ts';

/** The member's optional layouts (#218 two panes, #219 tabs), stored on the server so they follow the member. */
export const useLayoutStore = defineStore('layout', {
  state: (): Layout => ({ ...DEFAULT_LAYOUT }),
  actions: {
    /** Takes layouts the server confirmed (from /api/v1/me or a save). */
    apply(l: Layout) {
      this.dualPane = l.dualPane;
      this.tabs = l.tabs;
    },
    /** Saves and then applies; a refusal rejects with the ApiFailure and changes nothing, for the view to show. */
    async save(l: Layout) {
      this.apply(await api.put<Layout>('/api/v1/settings/layout', l));
    },
  },
});
