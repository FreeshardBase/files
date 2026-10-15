import { defineStore } from 'pinia';
import type { Favourite, FavouriteList } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';

/** The member's favourites (#155), for the Favourites view and the star of every item. */
export const useFavouritesStore = defineStore('favourites', {
  state: () => ({
    items: [] as Favourite[],
    loaded: false, // the first list has arrived; until then the view shows a placeholder
    error: null as ApiFailure | null,
    seq: 0, // request token: only the newest load() may touch state
  }),
  getters: {
    /** The favourite of one item, if it is one. */
    find: (s) => (source: string, path: string): Favourite | undefined =>
      s.items.find((f) => f.source === source && f.path === path),
  },
  actions: {
    async load() {
      const id = ++this.seq;
      this.error = null;
      try {
        const r = await api.get<FavouriteList>('/api/v1/favourites');
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
    async remove(id: number) {
      await api.delete(`/api/v1/favourites/${id}`);
      this.items = this.items.filter((f) => f.id !== id);
    },
    /** Stars the item, or unstars it if it is a favourite; answers whether it is one now. The caller reports a failure. */
    async toggle(source: string, path: string): Promise<boolean> {
      const had = this.find(source, path);
      if (had) { await this.remove(had.id); return false; }
      const f = await api.post<Favourite>('/api/v1/favourites', { source, path });
      if (!this.find(f.source, f.path)) this.items = [...this.items, f];
      return true;
    },
  },
});
