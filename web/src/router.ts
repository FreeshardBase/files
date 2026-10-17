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
import SignedOutView from './views/SignedOutView.vue';
import NotFoundView from './views/NotFoundView.vue';
import FileRequestsView from './views/FileRequestsView.vue';
import FileRequestPageView from './views/FileRequestPageView.vue';
import { SIGNED_OUT_PATH } from './api/paths.ts';

/** A public link's share page, a file request's page and the signed-out page: no session is loaded and no login is asked for there. */
export const isPublicPage = (pathname: string): boolean =>
  pathname === SIGNED_OUT_PATH || /^\/[sr]\/[A-Za-z0-9_-]{22}$/.test(pathname);

// The URL is /<source>/<folder path…>: `home`, `share:<id>` (#146) and `conn:<id>` (#148). `/trash`, `/recent`,
// `/favourites`, `/shared`, `/connections`, `/storage`, `/members`, `/settings`, `/requests` and `/share-target` can never clash with a folder, since folders live
// under their source.
export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: (to) => ({ path: '/home', query: to.query, hash: to.hash }) },
  // `folder`: the folder view shows the upload panel under its own toolbar (#239); App.vue shows it on every other view.
  { path: '/:source(home|share:[A-Za-z0-9_-]{1,64}|conn:[A-Za-z0-9_-]{1,64})/:path(.*)*', component: FolderView, meta: { folder: true } },
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
  // File requests (#217): the member's list, and a request's upload page for visitors, outside the signed-in shell.
  { path: '/requests', component: FileRequestsView },
  { path: '/r/:token([A-Za-z0-9_-]{22})', component: FileRequestPageView },
  // After sign-out (#222): outside the signed-in shell, and it never redirects to the login.
  { path: SIGNED_OUT_PATH, component: SignedOutView },
  // Any other address says it does not exist (#240), with the way to "My storage", instead of a silent redirect.
  { path: '/:pathMatch(.*)*', component: NotFoundView },
];

export const router = createRouter({ history: createWebHistory(), routes });
