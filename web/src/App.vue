<script setup lang="ts">
import { onMounted } from 'vue';
import { useSessionStore } from './stores/session.ts';
import { loginFailed } from './api/client.ts';
const session = useSessionStore();
const showLoginFailed = loginFailed();
onMounted(() => session.load());
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <span class="app-title">{{ $t('app.name') }}</span>
    </header>
    <main
      v-if="session.me"
      class="app-main"
    >
      <RouterView />
    </main>
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
