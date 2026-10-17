import { defineStore } from 'pinia';
import type { Comment, CommentList, FolderComments } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { parentOf } from '../location.ts';

const q = (source: string, path: string) => new URLSearchParams({ source, path }).toString();

/**
 * Comments (#213): the comment counts of the open folder's children, by path, for the list's badges, and an item's
 * thread with posting, editing and deleting, which keep the counts current.
 */
export const useCommentsStore = defineStore('comments', {
  state: () => ({
    folder: { source: '', path: '', byPath: {} as Record<string, number> },
    seq: 0, // request token: only the newest loadFolder() may touch the folder's counts
  }),
  actions: {
    /** The counts of one folder's children. A failure leaves the folder without badges; the listing says what failed. */
    async loadFolder(source: string, path: string) {
      const id = ++this.seq;
      try {
        const r = await api.get<FolderComments>('/api/v1/comments/folder', { source, path });
        if (id !== this.seq) return;
        this.folder = { source, path, byPath: Object.fromEntries(r.items.map((i) => [i.path, i.count])) };
      } catch (e) {
        if (id !== this.seq) return;
        if (!(e instanceof ApiFailure)) throw e;
        this.folder = { source, path, byPath: {} }; // handled: the folder shows no badges; its listing reports its own failure
      }
    },
    counted(source: string, path: string, count: number) {
      if (source !== this.folder.source || parentOf(path) !== this.folder.path) return;
      if (count > 0) this.folder.byPath[path] = count;
      else delete this.folder.byPath[path];
    },
    /** The item's thread, oldest first. The caller reports a failure. */
    async thread(source: string, path: string): Promise<Comment[]> {
      const comments = (await api.get<CommentList>('/api/v1/comments', { source, path })).comments;
      this.counted(source, path, comments.length);
      return comments;
    },
    async post(source: string, path: string, text: string): Promise<Comment> {
      return api.post<Comment>('/api/v1/comments', { source, path, text });
    },
    async edit(source: string, path: string, id: number, text: string): Promise<Comment> {
      return api.patch<Comment>(`/api/v1/comments/${id}`, { source, path, text });
    },
    async remove(source: string, path: string, id: number): Promise<void> {
      await api.delete(`/api/v1/comments/${id}?${q(source, path)}`);
    },
  },
});
