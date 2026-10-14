import { createRouter, createWebHistory } from 'vue-router';
import FolderView from './views/FolderView.vue';
export const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/:path(.*)*', component: FolderView }],
});
