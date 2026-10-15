import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router.ts';
import { i18n } from './i18n/index.ts';
import { syncHtmlLang } from './i18n/htmlLang.ts';
import { startTheme } from './theme.ts';
import './styles/app.css';

syncHtmlLang(i18n.global.locale);
startTheme();
createApp(App).use(createPinia()).use(router).use(i18n).mount('#app');

// The service worker (#158): the app shell without network and the Web Share Target. Only the built app registers it;
// under the dev server a cached shell would hide every edit.
if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
