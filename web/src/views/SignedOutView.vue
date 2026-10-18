<script setup lang="ts">
// Where sign-out lands (#222). No session is loaded and nothing redirects to the login: with the shard's single sign-on
// that would sign the member straight back in. Signing in again is the link, the member's own choice.
import AppTitle from '../components/AppTitle.vue';
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <AppTitle />
    </header>
    <main class="app-main signed-out">
      <h1
        class="view-title"
        tabindex="-1"
      >
        {{ $t('signedOut.title') }}
      </h1>
      <p>{{ $t('signedOut.text') }}</p>
      <a
        class="button primary"
        href="/auth/login"
      >{{ $t('signedOut.signIn') }}</a>
    </main>
  </div>
</template>
