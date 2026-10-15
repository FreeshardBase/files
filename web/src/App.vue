<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from './stores/session.ts';
import { loginFailed } from './api/client.ts';
import UploadPanel from './components/UploadPanel.vue';
import SearchBox from './components/SearchBox.vue';
import { isPublicPage } from './router.ts';
const session = useSessionStore();
const router = useRouter();
const showLoginFailed = loginFailed();
// A visitor of a public link (#147) has no account: the share page renders alone, without /api/v1/me.
const publicPage = isPublicPage(location.pathname);
onMounted(async () => {
  if (publicPage) return;
  await session.load();
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
    </header>
    <div
      v-if="session.me"
      class="app-body"
    >
      <nav
        class="app-nav"
        :aria-label="$t('nav.sources')"
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
      </nav>
      <main class="app-main">
        <UploadPanel />
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
