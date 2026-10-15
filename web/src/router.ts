import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import FolderView from './views/FolderView.vue';
import TrashView from './views/TrashView.vue';
import RecentView from './views/RecentView.vue';
import FavouritesView from './views/FavouritesView.vue';
import SharedView from './views/SharedView.vue';
import PublicLinkView from './views/PublicLinkView.vue';
import ConnectionsView from './views/ConnectionsView.vue';
import MigrateView from './views/MigrateView.vue';
import MigrationJobView from './views/MigrationJobView.vue';
import StorageView from './views/StorageView.vue';
import MembersView from './views/MembersView.vue';
import SettingsView from './views/SettingsView.vue';
import ShareTargetView from './views/ShareTargetView.vue';

/** A public link's share page: no session is loaded and no login is asked for there. */
export const isPublicPage = (pathname: string): boolean => /^\/s\/[A-Za-z0-9_-]{22}$/.test(pathname);

// The URL is /<source>/<folder path…>: `home`, `share:<id>` (#146) and `conn:<id>` (#148). `/trash`, `/recent`,
// `/favourites`, `/shared`, `/connections`, `/storage`, `/members`, `/settings` and `/share-target` can never clash with a folder, since folders live
// under their source.
export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: (to) => ({ path: '/home', query: to.query, hash: to.hash }) },
  { path: '/:source(home|share:[A-Za-z0-9_-]{1,64}|conn:[A-Za-z0-9_-]{1,64})/:path(.*)*', component: FolderView },
  { path: '/favourites', component: FavouritesView },
  { path: '/recent', component: RecentView },
  { path: '/shared', component: SharedView },
  { path: '/connections', component: ConnectionsView },
  { path: '/trash', component: TrashView },
  // The storage overview for every member, and the admin's page of members and quotas (#156).
  { path: '/storage', component: StorageView },
  { path: '/members', component: MembersView },
  // Settings (#157): the WebDAV address and the member's app passwords.
  { path: '/settings', component: SettingsView },
  // A cloud folder or account onto the shard (#153): the wizard, and one migration's progress, summary and cleanup.
  { path: '/migrate', component: MigrateView },
  { path: '/migrate/:id([0-9a-f]{32})', component: MigrationJobView },
  // The Web Share Target (#158): the service worker sends a share here with the id of its inbox entry.
  { path: '/share-target/:id([0-9a-f-]{36})?', component: ShareTargetView },
  // A public link's share page (#147): for visitors, outside the signed-in shell (App.vue).
  { path: '/s/:token([A-Za-z0-9_-]{22})', component: PublicLinkView },
  { path: '/:pathMatch(.*)*', redirect: '/home' },
];

export const router = createRouter({ history: createWebHistory(), routes });
