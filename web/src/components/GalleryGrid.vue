<script setup lang="ts">
// The gallery view (#144): the folder as a grid of tiles. Images, videos and PDFs show their thumbnail, everything else
// its line icon. A folder tile opens the folder, a file tile the preview overlay, which is the lightbox (←/→ step).
import { reactive, ref, watch } from 'vue';
import type { Entry } from '@files/shared';
import { hasThumbnail, thumbnailHref } from '../preview.ts';

const props = defineProps<{ entries: Entry[]; folderName: string; source: string }>();
const emit = defineEmits<{ open: [Entry] }>();
const tiles = ref<HTMLElement[]>([]);
// A thumbnail that could not be loaded (corrupt file, say) falls back to the icon instead of a broken image.
const failed = reactive(new Set<string>());

// Roving tab stop (#160): the grid is one Tab stop; arrows move within it, up and down by one row of tiles.
const active = ref(0);
watch(() => props.entries.length, (n) => {
  tiles.value.length = n;
  active.value = Math.max(0, Math.min(active.value, n - 1));
});
function focusTile(i: number) {
  active.value = Math.max(0, Math.min(props.entries.length - 1, i));
  tiles.value[active.value]?.focus();
}
// Tiles per row, from the layout: the grid's column count depends on the width.
const perRow = () => {
  const top = tiles.value[0]?.offsetTop;
  return Math.max(1, tiles.value.filter((t) => t.offsetTop === top).length);
};
function onKey(e: KeyboardEvent, i: number) {
  const to = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + perRow(), ArrowUp: i - perRow(),
    Home: 0, End: props.entries.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  focusTile(to);
}
defineExpose({
  focusPath: (path: string) => { const i = props.entries.findIndex((e) => e.path === path); if (i >= 0) focusTile(i); }, // after the preview
});
</script>

<template>
  <ul
    class="gallery"
    :aria-label="$t('a11y.gallery', { folder: folderName })"
  >
    <li
      v-for="(e, i) in entries"
      :key="e.path"
    >
      <button
        :ref="(el) => { if (el) tiles[i] = el as HTMLElement }"
        type="button"
        class="gallery-tile"
        :data-type="e.type"
        :tabindex="i === active ? 0 : -1"
        @focus="active = i"
        @keydown="onKey($event, i)"
        @click="emit('open', e)"
      >
        <img
          v-if="hasThumbnail(e) && !failed.has(e.path)"
          class="gallery-thumb"
          :src="thumbnailHref(source, e, 256)"
          alt=""
          loading="lazy"
          @error="failed.add(e.path)"
        >
        <span
          v-else
          class="gallery-icon"
        ><span
          class="icon"
          :class="e.type === 'directory' ? 'icon-folder' : 'icon-file'"
          aria-hidden="true"
        /></span>
        <span class="gallery-name">{{ e.name }}</span>
      </button>
    </li>
  </ul>
</template>
