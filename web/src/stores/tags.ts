import { defineStore } from 'pinia';
import { foldTag, type FolderTags, type ItemTags, type TagList } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { parentOf } from '../location.ts';

/**
 * The member's tags (#212): every tag with its count (the suggestions of the chip editor and "Add tag"), and the tags of
 * the folder that is open, by path, for the chips of its list and gallery.
 */
export const useTagsStore = defineStore('tags', {
  state: () => ({
    all: [] as TagList['tags'],
    folder: { source: '', path: '', byPath: {} as Record<string, string[]> },
    seq: 0, // request token: only the newest loadFolder() may touch the folder's tags
  }),
  actions: {
    async loadAll() {
      try { this.all = (await api.get<TagList>('/api/v1/tags')).tags; }
      catch (e) {
        if (!(e instanceof ApiFailure)) throw e;
        this.all = []; // handled: without the list the editor offers no suggestions; adding still works
      }
    },
    /** The tags of the children of one folder. A failure leaves the folder without chips; the listing says what failed. */
    async loadFolder(source: string, path: string) {
      const id = ++this.seq;
      try {
        const r = await api.get<FolderTags>('/api/v1/tags/folder', { source, path });
        if (id !== this.seq) return;
        this.folder = { source, path, byPath: Object.fromEntries(r.items.map((i) => [i.path, i.tags])) };
      } catch (e) {
        if (id !== this.seq) return;
        if (!(e instanceof ApiFailure)) throw e;
        this.folder = { source, path, byPath: {} }; // handled: the folder shows no chips; its listing reports its own failure
      }
    },
    async ofItem(source: string, path: string): Promise<string[]> {
      return (await api.get<{ tags: string[] }>('/api/v1/tags/item', { source, path })).tags;
    },
    // The open folder's chips follow every change made here.
    applied(source: string, items: ItemTags[]) {
      for (const it of items) {
        if (source === this.folder.source && parentOf(it.path) === this.folder.path) this.folder.byPath[it.path] = it.tags;
      }
    },
    /** Puts `tag` on every path (all or nothing); answers the items' tags. The caller reports a failure. */
    async add(source: string, paths: string[], tag: string): Promise<ItemTags[]> {
      const r = await api.post<{ items: ItemTags[] }>('/api/v1/tags/add', { source, paths, tag });
      this.applied(source, r.items);
      void this.loadAll();
      return r.items;
    },
    async remove(source: string, path: string, tag: string): Promise<void> {
      await api.post('/api/v1/tags/remove', { source, paths: [path], tag });
      const had = source === this.folder.source ? this.folder.byPath[path] : undefined;
      if (had) this.folder.byPath[path] = had.filter((x) => foldTag(x) !== foldTag(tag));
      void this.loadAll();
    },
  },
});
