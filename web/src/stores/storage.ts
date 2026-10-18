import { defineStore } from 'pinia';
import type { DiskStatus, MemberUsage, MemberUsageList, StorageOverview } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';

/** The caller's storage overview (#156): shard usage and quota, provider quotas, largest folders. */
export const useStorageStore = defineStore('storage', {
  state: () => ({
    overview: null as StorageOverview | null,
    loaded: false, // the first answer has arrived; until then the view shows a placeholder
    error: null as ApiFailure | null,
    seq: 0, // request token: only the newest load() may touch state
  }),
  actions: {
    async load() {
      const id = ++this.seq;
      this.error = null;
      try {
        const r = await api.get<StorageOverview>('/api/v1/storage');
        if (id !== this.seq) return;
        this.overview = r;
      } catch (e) {
        if (id !== this.seq) return;
        if (!(e instanceof ApiFailure)) throw e;
        this.error = e; this.overview = null;
      } finally {
        if (id === this.seq) this.loaded = true;
      }
    },
  },
});

/**
 * The shard's disk and its reserve (#320), for the admin only: the storage page shows it, the shell's banner warns from
 * 90 % used. Loaded once at sign-in and again by the storage page.
 */
export const useDiskStore = defineStore('disk', {
  state: () => ({
    status: null as DiskStatus | null,
    error: null as ApiFailure | null,
    seq: 0,
  }),
  actions: {
    async load() {
      const id = ++this.seq;
      try {
        const r = await api.get<DiskStatus>('/api/v1/admin/disk');
        if (id !== this.seq) return;
        this.status = r; this.error = null;
      } catch (e) {
        if (id !== this.seq) return;
        if (!(e instanceof ApiFailure)) throw e;
        this.error = e; this.status = null;
      }
    },
  },
});

/** The admin's member list with usage and quota (#156). A member who is not the admin gets FORBIDDEN from the server. */
export const useMembersStore = defineStore('members', {
  state: () => ({
    items: [] as MemberUsage[],
    loaded: false,
    error: null as ApiFailure | null,
    seq: 0,
  }),
  actions: {
    async load() {
      const id = ++this.seq;
      this.error = null;
      try {
        const r = await api.get<MemberUsageList>('/api/v1/admin/members');
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
    /** Sets (bytes) or removes (`null`) a member's quota; the row shows the server's answer. */
    async setQuota(memberId: string, quotaBytes: number | null) {
      const m = await api.put<MemberUsage>(`/api/v1/admin/members/${encodeURIComponent(memberId)}/quota`, { quotaBytes });
      this.items = this.items.map((i) => (i.id === m.id ? m : i));
      return m;
    },
  },
});
