import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import FolderView from './views/FolderView.vue';

// The URL is /<source>/<folder path…>. Only `home` is routed today; `conn:<id>` and `share:<id>` come later.
export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: (to) => ({ path: '/home', query: to.query, hash: to.hash }) },
  { path: '/:source(home)/:path(.*)*', component: FolderView },
  { path: '/:pathMatch(.*)*', redirect: '/home' },
];

export const router = createRouter({ history: createWebHistory(), routes });
