import { defineStore } from 'pinia';
import type { SaveSmartFolderRequest, SmartFolder, SmartFolderList } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';

/** The member's smart folders (#214), for the sidebar and their pages. Results are fetched by the page on every open. */
export const useSmartFoldersStore = defineStore('smartFolders', {
  state: () => ({
    items: [] as SmartFolder[],
    loaded: false,
    error: null as ApiFailure | null,
  }),
  getters: {
    byId: (s) => (id: string): SmartFolder | undefined => s.items.find((f) => f.id === id),
  },
  actions: {
    async load() {
      this.error = null;
      try { this.items = (await api.get<SmartFolderList>('/api/v1/smart-folders')).items; }
      catch (e) {
        if (!(e instanceof ApiFailure)) throw e;
        this.error = e; this.items = [];
      } finally { this.loaded = true; }
    },
    /** The caller reports a failure of these three. */
    async create(body: SaveSmartFolderRequest): Promise<SmartFolder> {
      const f = await api.post<SmartFolder>('/api/v1/smart-folders', body);
      this.items = [...this.items, f];
      return f;
    },
    async update(id: string, body: SaveSmartFolderRequest): Promise<SmartFolder> {
      const f = await api.put<SmartFolder>(`/api/v1/smart-folders/${id}`, body);
      this.items = this.items.map((x) => (x.id === id ? f : x));
      return f;
    },
    async remove(id: string): Promise<void> {
      await api.delete(`/api/v1/smart-folders/${id}`);
      this.items = this.items.filter((x) => x.id !== id);
    },
  },
});
