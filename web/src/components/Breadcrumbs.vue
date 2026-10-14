<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ path: string }>();
const parts = computed(() => {
  const segs = props.path.split('/').filter(Boolean);
  return segs.map((name, i) => ({ name, to: '/' + segs.slice(0, i + 1).map(encodeURIComponent).join('/') }));
});
</script>
<template>
  <nav
    :aria-label="$t('a11y.breadcrumbs')"
    class="breadcrumbs"
  >
    <RouterLink to="/">
      {{ $t('nav.breadcrumbRoot') }}
    </RouterLink>
    <template
      v-for="p in parts"
      :key="p.to"
    >
      <span
        aria-hidden="true"
        class="sep"
      >/</span>
      <RouterLink :to="p.to">
        {{ p.name }}
      </RouterLink>
    </template>
  </nav>
</template>
