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
  </div>
</template>
