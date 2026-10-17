// The document title (#236 P3): the place or page in words, then the app ("Projekte – Dateien"), so tabs, the history
// and bookmarks never show a connection's or share's id. A folder is named by its own name; the root of a source by the
// name the sidebar gives it.
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useConnectionsStore } from './stores/connections.ts';
import { useSharedStore } from './stores/shared.ts';
import { useSmartFoldersStore } from './stores/smartFolders.ts';

// The first segment of a page's address and the words it is called by (the sidebar's, or the page's own heading).
const PAGES: Record<string, string> = {
  favourites: 'nav.favourites', recent: 'nav.recent', shared: 'nav.shared', 'my-shares': 'nav.myShares', connections: 'nav.connections',
  trash: 'nav.trash', storage: 'nav.storage', duplicates: 'nav.duplicates', members: 'nav.members',
  settings: 'nav.settings', migrate: 'nav.migrate', requests: 'nav.requests', 'share-target': 'shareTarget.title',
  'signed-out': 'signedOut.title',
};

export function usePageTitle(): void {
  const { t } = useI18n();
  const route = useRoute();
  const connections = useConnectionsStore();
  const shared = useSharedStore();
  const smartFolders = useSmartFoldersStore();
  const page = computed((): string | null => {
    if (route.meta.folder) {
      const path = route.params.path;
      const last = Array.isArray(path) ? path.at(-1) : path;
      if (last) return last;
      const source = String(route.params.source);
      if (source === 'home') return t('nav.home');
      if (source.startsWith('conn:')) return connections.bySource(source)?.providerName ?? t('nav.connections');
      return shared.items.find((s) => s.source === source)?.name ?? t('nav.shared');
    }
    if (route.matched.at(-1)?.path === '/:pathMatch(.*)*') return t('notFound.title');
    const first = route.path.split('/')[1] ?? '';
    if (first === 'tags') return String(route.params.name);
    if (first === 'smart') return smartFolders.items.find((f) => f.id === route.params.id)?.name ?? null;
    const key = PAGES[first];
    return key ? t(key) : null; // a public link's or file request's page: the app alone
  });
  // A share's root is named after the shared item, which the list of incoming shares holds.
  watch(() => String(route.params.source ?? ''), (source) => {
    if (source.startsWith('share:') && !shared.loaded) void shared.load();
  }, { immediate: true });
  watch(() => [page.value, t('app.name')] as const, ([p, app]) => {
    document.title = p === null ? app : t('app.pageTitle', { page: p, app });
  }, { immediate: true });
}
