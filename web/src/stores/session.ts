import { defineStore } from 'pinia';

export const useSessionStore = defineStore('session', {
  state: () => ({ me: null as { id: string } | null }),
  actions: {
    async load(): Promise<void> {
      // Stub: Task 10 replaces this with the real /api/v1/me call.
    },
  },
});
