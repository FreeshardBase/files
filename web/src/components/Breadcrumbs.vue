<script setup lang="ts">
import { computed, ref } from 'vue';
import { folderRoute } from '../api/paths.ts';
import { acceptDrag, droppedPaths } from '../dnd.ts';
const props = defineProps<{ source: string; path: string }>();
// Every crumb is a drop target: dragging list items onto it moves them into that folder.
const emit = defineEmits<{ drop: [string[], string] }>();
const parts = computed(() => {
  const segs = props.path.split('/').filter(Boolean);
  return [{ name: null, path: '/' }, ...segs.map((name, i) => ({ name, path: '/' + segs.slice(0, i + 1).join('/') }))]
    .map((p) => ({ ...p, to: folderRoute(props.source, p.path) }));
});
const over = ref<string | null>(null);
function onDragOver(e: DragEvent, path: string) { if (acceptDrag(e)) over.value = path; }
function onDrop(e: DragEvent, path: string) {
  over.value = null;
  const paths = droppedPaths(e);
  if (paths) emit('drop', paths, path);
}
</script>
<template>
  <nav
    :aria-label="$t('a11y.breadcrumbs')"
    class="breadcrumbs"
  >
    <template
      v-for="(p, i) in parts"
      :key="p.to"
    >
      <span
        v-if="i > 0"
        aria-hidden="true"
        class="sep"
      >/</span>
      <RouterLink
        :to="p.to"
        :class="{ 'drop-target': over === p.path }"
        @dragover="onDragOver($event, p.path)"
        @dragleave="over = over === p.path ? null : over"
        @drop="onDrop($event, p.path)"
      >
        {{ p.name ?? $t('nav.breadcrumbRoot') }}
      </RouterLink>
    </template>
  </nav>
</template>
