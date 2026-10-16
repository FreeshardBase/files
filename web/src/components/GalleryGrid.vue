<script setup lang="ts">
// The gallery view (#144): the folder as a grid of tiles. Images, videos and PDFs show their thumbnail, everything else
// its line icon. A folder tile opens the folder, a file tile the preview overlay, which is the lightbox (←/→ step).
// Large folders (#225): only the rows of tiles near the viewport are in the DOM (`useWindowedRows`), plus the tile with
// the tab stop; each tile carries aria-setsize and aria-posinset, so the list still counts the whole folder.
import { nextTick, onMounted, onUpdated, reactive, ref, watch } from 'vue';
import type { Entry } from '@files/shared';
import { hasThumbnail, thumbnailHref } from '../preview.ts';
import { useWindowedRows, WINDOW_FROM, type Slot } from '../virtual.ts';

const props = defineProps<{ entries: Entry[]; folderName: string; source: string }>();
const emit = defineEmits<{ open: [Entry] }>();
const grid = ref<HTMLElement>();
// A thumbnail that could not be loaded (corrupt file, say) falls back to the icon instead of a broken image.
const failed = reactive(new Set<string>());

// Roving tab stop (#160): the grid is one Tab stop; arrows move within it, up and down by one row of tiles.
const active = ref(0);
watch(() => props.entries.length, (n) => {
  active.value = Math.max(0, Math.min(active.value, n - 1));
});

// The layout, measured: tiles per row from the grid's resolved columns (they depend on the width), and the height of a
// row of tiles plus the gap below it. Every tile has the same height (a square and one line of name).
const perRow = ref(1);
const stride = ref(200);
const rowGap = ref(0);
function measure() {
  const el = grid.value;
  if (!el) return;
  const style = getComputedStyle(el);
  perRow.value = Math.max(1, style.gridTemplateColumns.split(' ').filter((c) => c && c !== 'none').length);
  rowGap.value = parseFloat(style.rowGap) || 0;
  const h = el.querySelector('li[aria-posinset]')?.getBoundingClientRect().height ?? 0;
  if (h > 0) stride.value = h + rowGap.value;
}
onMounted(measure);
onUpdated(measure);
const { slots } = useWindowedRows(grid, {
  count: () => Math.ceil(props.entries.length / perRow.value), size: () => stride.value,
  pinned: () => Math.floor(active.value / perRow.value), trim: () => rowGap.value, layout: measure,
  whole: () => props.entries.length <= WINDOW_FROM,
});
// The tiles of a row slot (the row of the tab stop is rendered whole wherever it is, so the grid stays in step).
function tilesOf(s: Slot) {
  if (s.row === undefined) return [];
  const from = s.row * perRow.value;
  return Array.from({ length: Math.min(perRow.value, props.entries.length - from) }, (_, k) => ({ e: props.entries[from + k]!, i: from + k }));
}

const tileEl = (i: number) => grid.value?.querySelector<HTMLElement>(`li[aria-posinset="${i + 1}"] > button`);
async function focusTile(i: number) {
  active.value = Math.max(0, Math.min(props.entries.length - 1, i));
  const at = active.value;
  if (!tileEl(at)) await nextTick();
  if (active.value === at) tileEl(at)?.focus();
}
function onKey(e: KeyboardEvent, i: number) {
  const to = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + perRow.value, ArrowUp: i - perRow.value,
    Home: 0, End: props.entries.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  void focusTile(to);
}
defineExpose({
  focusPath: (path: string) => { const i = props.entries.findIndex((e) => e.path === path); if (i >= 0) void focusTile(i); }, // after the preview
});
</script>

<template>
  <ul
    ref="grid"
    class="gallery"
    :aria-label="$t('a11y.gallery', { folder: folderName })"
  >
    <template
      v-for="s in slots"
      :key="s.key ?? `row${s.row}`"
    >
      <li
        v-if="s.key"
        class="virtual-spacer"
        aria-hidden="true"
        :style="{ height: `${s.size}px` }"
      />
      <template v-else>
        <li
          v-for="{ e, i } in tilesOf(s)"
          :key="e.path"
          :aria-setsize="entries.length"
          :aria-posinset="i + 1"
        >
          <button
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
      </template>
    </template>
  </ul>
</template>
