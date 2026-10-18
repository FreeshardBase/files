<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { folderRoute } from '../api/paths.ts';
import { acceptDrag, drag, droppedPaths, springLeave, springOver, type DropMode } from '../dnd.ts';
// `rootLabel`: the first crumb ("My storage", a share's name, a cloud's provider); `rootNote`: a muted note beside it (a
// cloud's account, #244); `editable`: crumbs take drops only where moves are allowed.
const props = withDefaults(defineProps<{ source: string; path: string; rootLabel?: string; rootNote?: string; editable?: boolean }>(),
  { rootLabel: '', rootNote: '', editable: true });
// Every crumb is a drop target: dragging list items onto it moves or copies them into that folder (#338). The third
// argument is the source the items came from, another one when they were dragged over from the other pane (#218).
// A crumb held under dragged items asks to be opened (`spring`).
const emit = defineEmits<{ drop: [string[], string, string, DropMode]; spring: [string] }>();
const parts = computed(() => {
  const segs = props.path.split('/').filter(Boolean);
  return [{ name: null, path: '/' }, ...segs.map((name, i) => ({ name, path: '/' + segs.slice(0, i + 1).join('/') }))]
    .map((p) => ({ ...p, to: folderRoute(props.source, p.path) }));
});
const { t } = useI18n();
const over = ref<string | null>(null);
watch(() => drag.items, (i) => { if (!i) over.value = null; }); // ended or cancelled without a leave
function onDragOver(e: DragEvent, p: { name: string | null; path: string }) {
  if (p.path !== props.path) springOver(e, `crumb:${props.source}:${p.path}`, () => emit('spring', p.path));
  if (props.editable && acceptDrag(e, props.source, p.name ?? (props.rootLabel || t('nav.breadcrumbRoot')))) over.value = p.path;
}
function onDragLeave(e: DragEvent, path: string) {
  springLeave(e, `crumb:${props.source}:${path}`);
  over.value = over.value === path ? null : over.value;
}
function onDrop(e: DragEvent, path: string) {
  over.value = null;
  if (!props.editable) return;
  const items = droppedPaths(e, props.source);
  if (items) emit('drop', items.paths, path, items.source, items.mode);
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
        @dragenter="onDragOver($event, p)"
        @dragover="onDragOver($event, p)"
        @dragleave="onDragLeave($event, p.path)"
        @drop="onDrop($event, p.path)"
      >
        {{ p.name ?? (rootLabel || $t('nav.breadcrumbRoot')) }}
      </RouterLink>
      <span
        v-if="i === 0 && rootNote"
        class="crumb-note"
        :title="rootNote"
      >{{ rootNote }}</span>
    </template>
  </nav>
</template>
