<script setup lang="ts">
import { computed } from 'vue';
import { folderRoute } from '../api/paths.ts';
const props = defineProps<{ source: string; path: string }>();
const parts = computed(() => {
  const segs = props.path.split('/').filter(Boolean);
  return segs.map((name, i) => ({ name, to: folderRoute(props.source, '/' + segs.slice(0, i + 1).join('/')) }));
});
</script>
<template>
  <nav
    :aria-label="$t('a11y.breadcrumbs')"
    class="breadcrumbs"
  >
    <RouterLink :to="folderRoute(source, '/')">
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
