import { defineStore } from 'pinia';
import type { CollisionPolicy, Entry, ListResponse } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';

const BASE = '/api/v1/sources/home';
const join = (dir: string, name: string) => (dir === '/' ? '' : dir) + '/' + name;

export const useFolderStore = defineStore('folder', {
  state: () => ({
    path: '/', entries: [] as Entry[], error: null as ApiFailure | null,
    loading: false, // initial load of a folder: the list is replaced by a placeholder
    refreshing: false, // relist of the folder already shown: the list stays mounted
    seq: 0, // request token: only the newest open() may touch state
  }),
  actions: {
    async open(path: string, opts: { refresh?: boolean } = {}) {
      const id = ++this.seq;
      this.path = path; this.error = null;
      if (opts.refresh) this.refreshing = true; else { this.loading = true; this.refreshing = false; }
      try {
        const all: Entry[] = []; let cursor: string | undefined;
        do {
          const page: ListResponse = await api.get(`${BASE}/list`, cursor ? { path, cursor } : { path });
          if (id !== this.seq) return;
          all.push(...page.entries); cursor = page.next;
        } while (cursor);
        this.entries = all;
      } catch (e) {
        if (id !== this.seq) return;
        if (!(e instanceof ApiFailure)) throw e;
        this.error = e; this.entries = [];
      } finally {
        if (id === this.seq) { this.loading = false; this.refreshing = false; }
      }
    },
    /** PUTs into `dir` (captured by the caller, so navigating away mid-batch does not redirect the file). The caller relists. */
    async upload(file: File, dir: string, onCollision: CollisionPolicy = 'fail', onProgress?: (f: number) => void): Promise<Entry> {
      return api.put<Entry>(`${BASE}/content`, { path: join(dir, file.name), onCollision }, file, onProgress);
    },
    async mkdir(name: string) {
      const dir = this.path;
      await api.post(`${BASE}/mkdir`, { path: join(dir, name) });
      if (dir === this.path) await this.open(dir, { refresh: true });
    },
  },
});
