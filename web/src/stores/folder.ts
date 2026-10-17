import { defineStore, getActivePinia } from 'pinia';
import type { Access, CollisionPolicy, DeleteRequest, Entry, ListResponse, TransferRequest } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { sourceApi } from '../api/paths.ts';

export const join = (dir: string, name: string) => (dir === '/' ? '' : dir) + '/' + name;

/** Every entry of a folder, page by page. */
export async function listAll(source: string, path: string): Promise<Entry[]> {
  const all: Entry[] = []; let cursor: string | undefined;
  do {
    const page: ListResponse = await api.get(`${sourceApi(source)}/list`, cursor ? { path, cursor } : { path });
    all.push(...page.entries); cursor = page.next;
  } while (cursor);
  return all;
}

const defineFolderStore = (id: string) => defineStore(id, {
  state: () => ({
    source: 'home', // which source the folder belongs to; every request is built from it
    path: '/', entries: [] as Entry[], error: null as ApiFailure | null,
    loading: false, // initial load of a folder: the list is replaced by a placeholder
    refreshing: false, // relist of the folder already shown: the list stays mounted
    seq: 0, // request token: only the newest open() may touch state
    // What the caller may do in the source, from the newest listing (#146). The home is always `edit`; a share starts
    // as `read`, so no change is offered before the server has said it is allowed.
    access: 'edit' as Access,
  }),
  actions: {
    async open(path: string, opts: { refresh?: boolean; source?: string } = {}) {
      const id = ++this.seq;
      if (opts.source !== undefined && opts.source !== this.source) {
        this.source = opts.source;
        this.access = this.source === 'home' ? 'edit' : 'read';
      }
      const base = sourceApi(this.source);
      this.path = path; this.error = null;
      if (opts.refresh) this.refreshing = true; else { this.loading = true; this.refreshing = false; }
      try {
        const all: Entry[] = []; let cursor: string | undefined;
        do {
          const page: ListResponse = await api.get(`${base}/list`, cursor ? { path, cursor } : { path });
          if (id !== this.seq) return;
          all.push(...page.entries); cursor = page.next; this.access = page.access;
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
    /** Creates `name` in the open folder and relists it if it is still open. Answers the new folder. */
    async mkdir(name: string): Promise<Entry> {
      const dir = this.path; const source = this.source;
      const created = await api.post<Entry>(`${sourceApi(source)}/mkdir`, { path: join(dir, name) });
      if (dir === this.path && source === this.source) await this.open(dir, { refresh: true });
      return created;
    },
  },
});

// One folder store per open location (#218, #219): each pane and each tab lists its own folder. Without two panes or
// tabs there is one, `main`.
const stores = new Map<string, ReturnType<typeof defineFolderStore>>();
const storeId = (key: string) => (key === 'main' ? 'folder' : `folder:${key}`);
export function useFolderStore(key = 'main') {
  let use = stores.get(key);
  if (!use) stores.set(key, use = defineFolderStore(storeId(key)));
  return use();
}
/** Drops the store of a closed tab. */
export function disposeFolderStore(key: string): void {
  const use = stores.get(key);
  if (!use) return;
  use().$dispose();
  stores.delete(key);
  const pinia = getActivePinia();
  if (pinia) delete pinia.state.value[storeId(key)];
}

/**
 * Items marked with "Move"/"Copy" (Ctrl+X/C), pasted into whichever folder is open later. Survives navigation and is
 * one for all panes and tabs: marked in one, pasted in another.
 */
export const useClipboardStore = defineStore('clipboard', {
  state: () => ({ items: null as { mode: 'move' | 'copy'; source: string; entries: Entry[] } | null }),
});
