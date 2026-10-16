<script setup lang="ts">
// A list that is loading with nothing in place yet (#240): six rows at the row height with bars in the hairline colour
// and no shimmer, so the page does not jump when the rows arrive. The loading text stays for screen readers.
const ROWS = 6;
</script>

<template>
  <div
    class="row-skeleton"
    aria-busy="true"
  >
    <p
      class="visually-hidden"
      role="status"
    >
      {{ $t('folder.loading') }}
    </p>
    <div
      v-for="i in ROWS"
      :key="i"
      class="skeleton-row"
      aria-hidden="true"
    >
      <span class="skeleton-bar skeleton-icon" />
      <span class="skeleton-bar skeleton-name" />
      <span class="skeleton-bar skeleton-meta" />
    </div>
  </div>
</template>
