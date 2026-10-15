import { defineStore } from 'pinia';
import type { AuthorizeRequest, AuthorizeResponse, Connection, ConnectionList, Library, LibraryList, PickLibraryRequest, ProviderInfo,
  Site, SiteList } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';

/** The member's own cloud connections (#148), for the sidebar and the "Cloud accounts" page. */
export const useConnectionsStore = defineStore('connections', {
  state: () => ({
    items: [] as Connection[],
    providers: [] as ProviderInfo[],
    loaded: false, // the first list has arrived
    error: null as ApiFailure | null,
    seq: 0, // request token: only the newest load() may touch state
  }),
  getters: {
    /** The connection behind a source `conn:<id>`, if it is one of the member's. */
    bySource: (s) => (source: string): Connection | undefined => s.items.find((c) => c.source === source),
  },
  actions: {
    async load() {
      const id = ++this.seq;
      this.error = null;
      try {
        const r = await api.get<ConnectionList>('/api/v1/connections');
        if (id !== this.seq) return;
        this.items = r.items; this.providers = r.providers;
      } catch (e) {
        if (id !== this.seq) return;
        if (!(e instanceof ApiFailure)) throw e;
        this.error = e;
      } finally {
        if (id === this.seq) this.loaded = true;
      }
    },
    /** Sends the browser to the provider's consent page; it comes back through the server's callback. */
    async authorize(body: AuthorizeRequest) {
      const { url } = await api.post<AuthorizeResponse>('/api/v1/connections/authorize', body);
      location.assign(url);
    },
    /** Asks the provider live whether the connection still works; the caller reports a failure. */
    async check(id: string) {
      const c = await api.post<Connection>(`/api/v1/connections/${encodeURIComponent(id)}/check`, {});
      this.items = this.items.map((x) => (x.id === id ? c : x));
    },
    /** The SharePoint picker (#151): sites matching `q` (all for an empty one) and a site's document libraries. */
    async sites(id: string, q: string): Promise<Site[]> {
      return (await api.get<SiteList>(`/api/v1/connections/${encodeURIComponent(id)}/sites`, { q })).items;
    },
    async libraries(id: string, site: string): Promise<Library[]> {
      return (await api.get<LibraryList>(`/api/v1/connections/${encodeURIComponent(id)}/sites/${encodeURIComponent(site)}/libraries`)).items;
    },
    /** Gives a pending SharePoint connection its library; answers the connection, now with its files. */
    async pickLibrary(id: string, body: PickLibraryRequest): Promise<Connection> {
      const c = await api.put<Connection>(`/api/v1/connections/${encodeURIComponent(id)}/library`, body);
      this.items = this.items.map((x) => (x.id === id ? c : x));
      return c;
    },
    async unlink(id: string) {
      await api.delete(`/api/v1/connections/${encodeURIComponent(id)}`);
      await this.load();
    },
  },
});
