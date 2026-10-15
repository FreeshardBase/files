import { defineStore } from 'pinia';
import type { CollisionPolicy, DeleteRequest, Entry, ListResponse, TransferRequest } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { sourceApi } from '../api/paths.ts';

export const join = (dir: string, name: string) => (dir === '/' ? '' : dir) + '/' + name;

export const useFolderStore = defineStore('folder', {
  state: () => ({
    source: 'home', // which source the folder belongs to; every request is built from it
    path: '/', entries: [] as Entry[], error: null as ApiFailure | null,
    loading: false, // initial load of a folder: the list is replaced by a placeholder
    refreshing: false, // relist of the folder already shown: the list stays mounted
    seq: 0, // request token: only the newest open() may touch state
    // Items marked with "Move"/"Copy" (Ctrl+X/C), pasted into whichever folder is open later. Survives navigation.
    clipboard: null as { mode: 'move' | 'copy'; source: string; entries: Entry[] } | null,
  }),
  actions: {
    async open(path: string, opts: { refresh?: boolean; source?: string } = {}) {
      const id = ++this.seq;
      if (opts.source !== undefined) this.source = opts.source;
      const base = sourceApi(this.source);
      this.path = path; this.error = null;
      if (opts.refresh) this.refreshing = true; else { this.loading = true; this.refreshing = false; }
      try {
        const all: Entry[] = []; let cursor: string | undefined;
        do {
          const page: ListResponse = await api.get(`${base}/list`, cursor ? { path, cursor } : { path });
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
    /** Move (also rename) or copy within one source. The caller relists. */
    async transfer(op: 'move' | 'copy', source: string, from: string, to: string, onCollision: CollisionPolicy): Promise<Entry> {
      return api.post<Entry>(`${sourceApi(source)}/${op}`, { from, to, onCollision } satisfies TransferRequest);
    },
    /** Moves every path to the trash, all or nothing. The caller relists. */
    async trash(source: string, paths: string[]): Promise<void> {
      await api.post(`${sourceApi(source)}/delete`, { paths } satisfies DeleteRequest);
    },
    async mkdir(name: string) {
      const dir = this.path; const source = this.source;
      await api.post(`${sourceApi(source)}/mkdir`, { path: join(dir, name) });
      if (dir === this.path && source === this.source) await this.open(dir, { refresh: true });
    },
  },
});
