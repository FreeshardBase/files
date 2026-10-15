import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import FolderView from './views/FolderView.vue';
import TrashView from './views/TrashView.vue';
import RecentView from './views/RecentView.vue';
import SharedView from './views/SharedView.vue';

// The URL is /<source>/<folder path…>. `home` and `share:<id>` (#146) are routed; `conn:<id>` comes with #148.
// `/trash`, `/recent` and `/shared` can never clash with a folder, since folders live under their source.
export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: (to) => ({ path: '/home', query: to.query, hash: to.hash }) },
  { path: '/:source(home|share:[A-Za-z0-9_-]{1,64})/:path(.*)*', component: FolderView },
  { path: '/recent', component: RecentView },
  { path: '/shared', component: SharedView },
  { path: '/trash', component: TrashView },
  { path: '/:pathMatch(.*)*', redirect: '/home' },
];

export const router = createRouter({ history: createWebHistory(), routes });
