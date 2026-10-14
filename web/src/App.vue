<script setup lang="ts">
import { onMounted } from 'vue';
import { useSessionStore } from './stores/session.ts';
const session = useSessionStore();
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
