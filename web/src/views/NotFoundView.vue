<script setup lang="ts">
// An address the app does not know (#240): said so in the shell, with the way to "My storage", instead of a silent
// redirect.
import StateAlert from '../components/StateAlert.vue';
</script>

<template>
  <section class="page">
    <StateAlert
      :title="$t('notFound.title')"
      :text="$t('notFound.text')"
    >
      <RouterLink
        class="button primary"
        to="/home"
      >
        {{ $t('nav.toHome') }}
      </RouterLink>
    </StateAlert>
  </section>
</template>
