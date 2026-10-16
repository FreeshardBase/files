<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSessionStore } from './stores/session.ts';
import { loginFailed, takeInterruptedAction } from './api/client.ts';
import UploadPanel from './components/UploadPanel.vue';
import TransferPanel from './components/TransferPanel.vue';
import { useTransfersStore } from './stores/transfers.ts';
import SearchBox from './components/SearchBox.vue';
import { isPublicPage } from './router.ts';
import { useConnectionsStore } from './stores/connections.ts';
import { folderRoute } from './api/paths.ts';
import { useFavouritesStore } from './stores/favourites.ts';
import ShortcutsDialog from './components/ShortcutsDialog.vue';
const session = useSessionStore();
const connections = useConnectionsStore();
const favourites = useFavouritesStore();
const transfers = useTransfersStore();
const router = useRouter();
const route = useRoute();
const showLoginFailed = loginFailed();
// A visitor of a public link (#147) has no account: the share page renders alone, without /api/v1/me. So does the
// signed-out page (#222), which must not send the browser to the login.
const publicPage = isPublicPage(location.pathname);
// Offline the service worker still starts the shell (#158), but no data loads; the banner says why.
const online = ref(navigator.onLine);
const onConnectivity = () => { online.value = navigator.onLine; };
window.addEventListener('online', onConnectivity);
window.addEventListener('offline', onConnectivity);
// On a phone the places collapse behind one toggle (#160); choosing a place closes them again. On a wide screen the
// toggle is hidden and the places always show (CSS).
const placesOpen = ref(false);
// An expired session sent the member through the login in the middle of an action (#230); once back, they are told it
// did not happen, until they dismiss the note.
const actionLost = ref(false);
watch(() => route.fullPath, () => { placesOpen.value = false; });
// "?" opens the keyboard shortcuts, except while typing or while another dialog is open.
const shortcutsOpen = ref(false);
function onKey(e: KeyboardEvent) {
  if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || shortcutsOpen.value || !session.me) return;
  const at = e.target instanceof HTMLElement ? e.target : null;
  if (at?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  if (document.querySelector('[aria-modal="true"]')) return;
  e.preventDefault();
  shortcutsOpen.value = true;
}
window.addEventListener('keydown', onKey);
onUnmounted(() => {
  window.removeEventListener('online', onConnectivity); window.removeEventListener('offline', onConnectivity);
  window.removeEventListener('keydown', onKey);
});
onMounted(async () => {
  if (publicPage) return;
  await session.load();
  if (session.me) {
    void connections.load(); // the member's clouds in the sidebar (#148)
    void favourites.load(); // the star of every item (#155)
    transfers.connect(); // the member's transfer jobs, live (#152)
    actionLost.value = takeInterruptedAction();
  }
  if (!showLoginFailed) return;
  // The alert is decided; drop the flag from the URL so a reload or bookmark does not repeat it.
  await router.isReady();
  const query = { ...router.currentRoute.value.query };
  delete query.loginError;
  await router.replace({ query });
});
</script>

<template>
  <RouterView v-if="publicPage" />
  <div
    v-else
    class="app-shell"
  >
    <header class="app-header">
      <span class="app-title">{{ $t('app.name') }}</span>
      <SearchBox v-if="session.me" />
      <template v-if="session.me">
        <span
          class="app-user"
          :title="session.me.email"
        >{{ session.me.displayName }}</span>
        <button
          type="button"
          class="icon-button"
          :aria-label="$t('shortcuts.title')"
          :title="$t('shortcuts.title')"
          @click="shortcutsOpen = true"
        >
          <span
            class="icon icon-keyboard"
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          class="icon-button"
          :aria-label="$t('app.signOut')"
          :title="$t('app.signOut')"
          @click="session.signOut()"
        >
          <span
            class="icon icon-sign-out"
            aria-hidden="true"
          />
        </button>
      </template>
    </header>
    <p
      v-if="session.signOutError"
      class="offline-banner"
      role="alert"
    >
      {{ $t('app.signOutFailed', { reason: $t(`errors.${session.signOutError.code}`, session.signOutError.params ?? {}) }) }}
    </p>
    <div
      v-if="actionLost"
      class="offline-banner action-lost"
      role="alert"
    >
      <p>{{ $t('app.actionLost') }}</p>
      <button
        type="button"
        class="button"
        @click="actionLost = false"
      >
        {{ $t('app.dismiss') }}
      </button>
    </div>
    <ShortcutsDialog
      v-if="shortcutsOpen"
      @close="shortcutsOpen = false"
    />
    <p
      v-if="!online"
      class="offline-banner"
      role="status"
    >
      <span
        class="icon icon-offline"
        aria-hidden="true"
      />
      {{ $t('app.offline') }}
    </p>
    <div
      v-if="session.me"
      class="app-body"
    >
      <nav
        class="app-nav"
        :class="{ open: placesOpen }"
        :aria-label="$t('nav.sources')"
      >
        <button
          type="button"
          class="nav-toggle"
          aria-controls="places"
          :aria-expanded="placesOpen"
          @click="placesOpen = !placesOpen"
        >
          <span
            class="icon icon-menu"
            aria-hidden="true"
          />
          {{ $t('nav.sources') }}
        </button>
        <div
          id="places"
          class="nav-places"
        >
          <RouterLink
            to="/home"
            active-class="active"
          >
            <span
              class="icon icon-home"
              aria-hidden="true"
            />
            {{ $t('nav.home') }}
          </RouterLink>
          <RouterLink
            v-for="c in connections.items"
            :key="c.id"
            :to="c.status === 'library' ? '/connections' : folderRoute(c.source, '/')"
            active-class="active"
            class="nav-connection"
            :data-status="c.status"
          >
            <span
              class="icon icon-cloud"
              aria-hidden="true"
            />
            <span class="nav-connection-text">
              <span class="nav-connection-provider">{{ c.providerName }}</span>
              {{ c.account }}
              <span
                v-if="c.library"
                class="nav-connection-library"
              >{{ c.library }}</span>
              <span
                v-if="c.status !== 'ok'"
                class="nav-connection-status"
              >{{ $t(`connections.status.${c.status}`) }}</span>
            </span>
          </RouterLink>
          <RouterLink
            to="/connections"
            active-class="active"
          >
            <span
              class="icon icon-cloud-add"
              aria-hidden="true"
            />
            {{ $t('nav.connections') }}
          </RouterLink>
          <RouterLink
            to="/migrate"
            active-class="active"
          >
            <span
              class="icon icon-migrate"
              aria-hidden="true"
            />
            {{ $t('nav.migrate') }}
          </RouterLink>
          <RouterLink
            to="/favourites"
            active-class="active"
          >
            <span
              class="icon icon-star"
              aria-hidden="true"
            />
            {{ $t('nav.favourites') }}
          </RouterLink>
          <RouterLink
            to="/recent"
            active-class="active"
          >
            <span
              class="icon icon-recent"
              aria-hidden="true"
            />
            {{ $t('nav.recent') }}
          </RouterLink>
          <RouterLink
            to="/shared"
            active-class="active"
          >
            <span
              class="icon icon-shared"
              aria-hidden="true"
            />
            {{ $t('nav.shared') }}
          </RouterLink>
          <RouterLink
            to="/trash"
            active-class="active"
          >
            <span
              class="icon icon-trash"
              aria-hidden="true"
            />
            {{ $t('nav.trash') }}
          </RouterLink>
          <RouterLink
            to="/storage"
            active-class="active"
          >
            <span
              class="icon icon-storage"
              aria-hidden="true"
            />
            {{ $t('nav.storage') }}
          </RouterLink>
          <RouterLink
            v-if="session.me.role === 'admin'"
            to="/members"
            active-class="active"
          >
            <span
              class="icon icon-members"
              aria-hidden="true"
            />
            {{ $t('nav.members') }}
          </RouterLink>
          <RouterLink
            to="/settings"
            active-class="active"
          >
            <span
              class="icon icon-settings"
              aria-hidden="true"
            />
            {{ $t('nav.settings') }}
          </RouterLink>
        </div>
      </nav>
      <main class="app-main">
        <UploadPanel v-if="!route.meta.folder" />
        <TransferPanel />
        <RouterView />
      </main>
    </div>
    <main
      v-else-if="session.error && session.error.code === 'UNAUTHENTICATED' && showLoginFailed"
      class="app-main"
    >
      <p role="alert">
        {{ $t('errors.LOGIN_FAILED') }}
      </p>
      <a
        class="button"
        href="/auth/login"
      >{{ $t('app.signInAgain') }}</a>
    </main>
    <main
      v-else-if="session.error"
      class="app-main"
    >
      <p role="alert">
        {{ $t(`errors.${session.error.code}`) }}
      </p>
      <button
        type="button"
        class="button"
        @click="session.load()"
      >
        {{ $t('app.retry') }}
      </button>
    </main>
  </div>
</template>
