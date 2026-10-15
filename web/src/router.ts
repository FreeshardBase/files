import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import FolderView from './views/FolderView.vue';
import TrashView from './views/TrashView.vue';
import RecentView from './views/RecentView.vue';

// The URL is /<source>/<folder path…>. Only `home` is routed today; `conn:<id>` and `share:<id>` come later.
// `/trash` and `/recent` can never clash with a folder, since folders live under their source.
export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: (to) => ({ path: '/home', query: to.query, hash: to.hash }) },
  { path: '/:source(home)/:path(.*)*', component: FolderView },
  { path: '/recent', component: RecentView },
  { path: '/trash', component: TrashView },
  { path: '/:pathMatch(.*)*', redirect: '/home' },
];

export const router = createRouter({ history: createWebHistory(), routes });
