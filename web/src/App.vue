<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSessionStore } from './stores/session.ts';
import { loginFailed, takeInterruptedAction } from './api/client.ts';
import UploadPanel from './components/UploadPanel.vue';
import TransferPanel from './components/TransferPanel.vue';
import { useTransfersStore } from './stores/transfers.ts';
import { useUploadsStore } from './stores/uploads.ts';
import SearchBox from './components/SearchBox.vue';
import { isPublicPage } from './router.ts';
import { useConnectionsStore } from './stores/connections.ts';
import { folderRoute } from './api/paths.ts';
import { useFavouritesStore } from './stores/favourites.ts';
import { useSmartFoldersStore } from './stores/smartFolders.ts';
import ShortcutsDialog from './components/ShortcutsDialog.vue';
import StateAlert from './components/StateAlert.vue';
import { useRequestsStore } from './stores/requests.ts';
import { usePageTitle } from './pageTitle.ts';
const session = useSessionStore();
const requests = useRequestsStore();
const connections = useConnectionsStore();
const favourites = useFavouritesStore();
const smartFolders = useSmartFoldersStore();
const transfers = useTransfersStore();
const router = useRouter();
const route = useRoute();
const showLoginFailed = loginFailed();
usePageTitle();
// A failed login is said on its own, outside the shell; every other state keeps the shell (#240).
const loginFailedHere = computed(() => session.error?.code === 'UNAUTHENTICATED' && showLoginFailed);
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
// The badge of new files received through file requests (#217), brought up to date on every navigation.
watch(() => route.path, () => { if (session.me) void requests.load(); });
// The source the folder view shows (`home`, `conn:<id>`), so its sidebar entry stays current in every subfolder (#244).
const inSource = (source: string) => route.params.source === source;
// The member in the header as an initial (#244); the whole name is beside it on a wide screen and its tooltip.
const initial = computed(() => Array.from(session.me?.displayName.trim() ?? '')[0]?.toLocaleUpperCase() ?? '');
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
// Leaving the page while uploads run asks first (#233): what was sent of a tus upload stays, but the browser forgets the
// file, so it has to be picked again to go on. The browser words the question itself.
const uploads = useUploadsStore();
function onBeforeUnload(e: BeforeUnloadEvent) { if (uploads.active) e.preventDefault(); }
window.addEventListener('beforeunload', onBeforeUnload);
onUnmounted(() => {
  window.removeEventListener('online', onConnectivity); window.removeEventListener('offline', onConnectivity);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('beforeunload', onBeforeUnload);
});
onMounted(async () => {
  if (publicPage) return;
  await session.load();
  if (session.me) {
    void connections.load(); // the member's clouds in the sidebar (#148)
    void favourites.load(); // the star of every item (#155)
    void smartFolders.load(); // the member's smart folders in the sidebar (#214)
    void requests.load(); // the badge of new files from file requests (#217)
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
      <span class="app-title"><span
        class="icon icon-folder app-logo"
        aria-hidden="true"
      />{{ $t('app.name') }}</span>
      <SearchBox v-if="session.me" />
      <template v-if="session.me">
        <span
          class="app-user"
          :title="session.me.displayName"
        ><span
          class="fs-avatar app-avatar"
          aria-hidden="true"
        >{{ initial }}</span><span class="app-user-name">{{ session.me.displayName }}</span></span>
        <button
          type="button"
          class="icon-button shortcuts-button"
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
      v-if="!loginFailedHere"
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
          <!-- While /me loads (#240) the places are bars in the hairline colour; once it answers, or fails, they are real. -->
          <div
            v-if="!session.me && !session.error"
            class="nav-skeleton"
            aria-hidden="true"
          >
            <span
              v-for="i in 6"
              :key="i"
              class="skeleton-bar"
            />
          </div>
          <template v-else>
            <!-- Three groups under uppercase titles with hairlines between them, like Calendar's sidebar (#244). -->
            <div
              class="nav-group"
              role="group"
              aria-labelledby="nav-group-places"
            >
              <p
                id="nav-group-places"
                class="fs-label nav-group-title"
              >
                {{ $t('nav.groups.places') }}
              </p>
              <!-- A source's entry stays current in its subfolders (#244), where the path no longer matches its link. -->
              <RouterLink
                to="/home"
                active-class="active"
                :class="{ active: inSource('home') }"
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
                :class="{ active: inSource(c.source) }"
                :data-status="c.status"
              >
                <span
                  class="icon icon-cloud"
                  aria-hidden="true"
                />
                <span class="nav-connection-text">
                  <span class="nav-connection-provider">{{ c.providerName }}</span>
                  <span
                    class="nav-connection-account"
                    :title="c.account"
                  > {{ c.account }}</span>
                  <span
                    v-if="c.library"
                    class="nav-connection-library"
                    :title="c.library"
                  > {{ c.library }}</span>
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
            </div>
            <div
              class="nav-group"
              role="group"
              aria-labelledby="nav-group-collections"
            >
              <p
                id="nav-group-collections"
                class="fs-label nav-group-title"
              >
                {{ $t('nav.groups.collections') }}
              </p>
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
              <!-- The member's smart folders (#214), below Favourites. -->
              <RouterLink
                v-for="f in smartFolders.items"
                :key="f.id"
                :to="`/smart/${f.id}`"
                active-class="active"
                class="nav-smart"
              >
                <span
                  class="icon icon-search"
                  aria-hidden="true"
                />
                <span class="nav-smart-name">{{ f.name }}</span>
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
                to="/requests"
                active-class="active"
              >
                <span
                  class="icon icon-upload"
                  aria-hidden="true"
                />
                {{ $t('nav.requests') }}
                <span
                  v-if="requests.newFiles > 0"
                  class="nav-badge"
                  :title="$t('nav.requestsNew', { count: requests.newFiles }, requests.newFiles)"
                >
                  <span aria-hidden="true">{{ requests.newFiles }}</span>
                  <span class="visually-hidden">{{ $t('nav.requestsNew', { count: requests.newFiles }, requests.newFiles) }}</span>
                </span>
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
            </div>
            <div
              class="nav-group"
              role="group"
              aria-labelledby="nav-group-manage"
            >
              <p
                id="nav-group-manage"
                class="fs-label nav-group-title"
              >
                {{ $t('nav.groups.manage') }}
              </p>
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
                to="/duplicates"
                active-class="active"
              >
                <span
                  class="icon icon-file"
                  aria-hidden="true"
                />
                {{ $t('nav.duplicates') }}
              </RouterLink>
              <RouterLink
                v-if="session.me?.role === 'admin'"
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
            </div>
          </template>
        </div>
      </nav>
      <main class="app-main">
        <template v-if="session.me">
          <UploadPanel
            v-if="!route.meta.folder"
            @resume="(files, at) => uploads.enqueue(files, at, { settled: () => {} })"
          />
          <TransferPanel />
          <RouterView />
        </template>
        <!-- Without /me (offline, a server error) the shell stays and says why in the page column (#240). -->
        <section
          v-else-if="session.error"
          class="page"
        >
          <StateAlert
            :title="$t('app.loadFailed')"
            :text="$t(`errors.${session.error.code}`)"
          >
            <button
              type="button"
              class="button primary"
              @click="session.load()"
            >
              {{ $t('app.retry') }}
            </button>
          </StateAlert>
        </section>
        <section
          v-else
          class="page"
        >
          <p
            class="recent-empty"
            role="status"
          >
            {{ $t('folder.loading') }}
          </p>
        </section>
      </main>
    </div>
    <main
      v-else
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
  </div>
</template>
