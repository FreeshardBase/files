import { defineStore } from 'pinia';
import type { CollisionPolicy, Entry, ListResponse } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';

const BASE = '/api/v1/sources/home';
const join = (dir: string, name: string) => (dir === '/' ? '' : dir) + '/' + name;

export const useFolderStore = defineStore('folder', {
  state: () => ({ path: '/', entries: [] as Entry[], loading: false, error: null as ApiFailure | null }),
  actions: {
    async open(path: string) {
      this.path = path; this.loading = true; this.error = null;
      try {
        const all: Entry[] = []; let cursor: string | undefined;
        do {
          const page: ListResponse = await api.get(`${BASE}/list`, cursor ? { path, cursor } : { path });
          all.push(...page.entries); cursor = page.next;
        } while (cursor);
        if (this.path === path) this.entries = all;
      } catch (e) {
        if (!(e instanceof ApiFailure)) throw e;
        this.error = e; this.entries = [];
      } finally { this.loading = false; }
    },
    async upload(file: File, onCollision: CollisionPolicy = 'fail', onProgress?: (f: number) => void): Promise<Entry> {
      const entry = await api.put<Entry>(`${BASE}/content`, { path: join(this.path, file.name), onCollision }, file, onProgress);
      await this.open(this.path);
      return entry;
    },
    async mkdir(name: string) {
      await api.post(`${BASE}/mkdir`, { path: join(this.path, name) });
      await this.open(this.path);
    },
  },
});
