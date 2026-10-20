<script setup lang="ts">
// The gallery view (#144): the folder as a grid of tiles. Images, videos and PDFs show their thumbnail, everything else
// its line icon. A folder tile opens the folder, a file tile the preview overlay, which is the lightbox (←/→ step).
// Large folders (#225): only the rows of tiles near the viewport are in the DOM (`useWindowedRows`), plus the tile with
// the tab stop; each tile carries aria-setsize and aria-posinset, so the list still counts the whole folder.
// Selection and actions (#229) are the list's (`useItemActions`): a click opens, Ctrl/Shift+click and Space select, the
// context menu, Shift+F10 and each tile's menu button open the list's item menu. The tile's checkbox and menu button
// show on hover or focus, while the tile is selected, and always on a touch screen; there a long-press selects.
import { nextTick, onBeforeUpdate, onMounted, onUpdated, reactive, ref, watch } from 'vue';
import type { Entry } from '@files/shared';
import { hasThumbnail, pageThumb, thumbnailHref } from '../preview.ts';
import { nameParts } from '../format.ts';
import { useWindowedRows, WINDOW_FROM, type Slot } from '../virtual.ts';
import { useItemActions, useLongPress, wantsNativeMenu, type ItemAction } from '../itemActions.ts';
import ItemMenu from './ItemMenu.vue';
import TagChips from './TagChips.vue';

// `tags`: the member's tags by path (#212), as chips over the foot of the tile's square (the tile keeps its height).
// `toOther`: a second pane takes items (#218), as in the list. A middle click on a folder tile asks for a new tab (#219).
const props = withDefaults(defineProps<{ entries: Entry[]; folderName: string; source: string; selected?: string[];
  editable?: boolean; shareable?: boolean; starred?: string[]; tags?: Record<string, string[]>; toOther?: boolean }>(),
{ selected: () => [], editable: true, shareable: false, starred: () => [], tags: () => ({}), toOther: false });
const emit = defineEmits<{ open: [Entry]; 'update:selected': [string[]]; action: [ItemAction, Entry[], HTMLElement?]; paste: []; openTab: [Entry] }>();
function onAuxClick(e: MouseEvent, entry: Entry) {
  if (e.button !== 1 || entry.type !== 'directory') return;
  e.preventDefault();
  emit('openTab', entry);
}
const grid = ref<HTMLElement>();
// The menus of the rendered tiles by index, collected anew on every render.
const menus = new Map<number, InstanceType<typeof ItemMenu>>();
onBeforeUpdate(() => menus.clear());
const { chosen, toggle, itemsFor, headingFor, selectForMenu, fromMenu, onActionKey, onSelectClick } = useItemActions(props, {
  open: (e) => emit('open', e), select: (paths) => emit('update:selected', paths), action: (...args) => emit('action', ...args),
  paste: () => emit('paste'),
}, { showMenu: (i) => { void menus.get(i)?.show(); }, menuButton: (i) => menus.get(i)?.trigger });
// A long-press selects (the menu button is always there on a touch screen); the browser's own long-press context menu
// is dropped, so the press does not also open the item menu.
const press = useLongPress((i) => { active.value = i; toggle(i); });
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
  if (active.value !== at) return;
  tileEl(at)?.focus(); // scrolls only a tile outside the window; it is scrolled whole into sight too (#406, as in FileList)
  tileEl(at)?.scrollIntoView({ block: 'nearest' });
}
function onKey(e: KeyboardEvent, i: number) {
  const to = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + perRow.value, ArrowUp: i - perRow.value,
    Home: 0, End: props.entries.length - 1 }[e.key];
  if (to === undefined) { onActionKey(e, i); return; }
  e.preventDefault();
  void focusTile(to);
}
// Esc in the tile's checkbox, which lies outside the tile, clears the selection too (#420); the tile takes the focus.
function onCheckKey(e: KeyboardEvent, i: number) {
  if (e.key === 'Escape' && onActionKey(e, i)) void focusTile(i);
}
// Space is taken on keydown; the button would still click on keyup.
function onKeyUp(e: KeyboardEvent) { if (e.key === ' ') e.preventDefault(); }
function onClick(e: MouseEvent, i: number) {
  active.value = i;
  if (!onSelectClick(e, i)) emit('open', props.entries[i]!);
}
function onContextMenu(e: MouseEvent, i: number) {
  if (wantsNativeMenu(e)) return;
  e.preventDefault();
  if (press.touching()) return; // a held touch selects instead
  active.value = i;
  selectForMenu(i); // a tile outside the selection is selected alone first (#340)
  void menus.get(i)?.show();
}
defineExpose({
  focus: () => { void focusTile(active.value); }, // after an action took the focused tile away
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
          :class="{ selected: chosen.has(e.path) }"
          :aria-setsize="entries.length"
          :aria-posinset="i + 1"
        >
          <button
            type="button"
            class="gallery-tile"
            :aria-label="e.name"
            :data-type="e.type"
            :tabindex="i === active ? 0 : -1"
            @focus="active = i"
            @keydown="onKey($event, i)"
            @keyup="onKeyUp"
            @click.capture="press.onClickCapture"
            @click="onClick($event, i)"
            @contextmenu="onContextMenu($event, i)"
            @auxclick="onAuxClick($event, e)"
            @pointerdown="press.onPointerDown($event, i)"
            @pointermove="press.onPointerMove"
            @pointerup="press.onPointerUp"
            @pointercancel="press.onPointerUp"
          >
            <img
              v-if="hasThumbnail(e) && !failed.has(e.path)"
              class="gallery-thumb"
              :data-page="pageThumb(e)"
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
            <span
              class="gallery-name"
              :title="e.name"
            ><span class="gallery-name-head">{{ nameParts(e.name)[0] }}</span><span class="gallery-name-tail">{{ nameParts(e.name)[1] }}</span></span>
          </button>
          <!-- The tags lie over the foot of the square, outside the button, which holds no links (#212). -->
          <TagChips
            class="gallery-tags"
            :tags="tags[e.path] ?? []"
            :name="e.name"
            :max="2"
            in-row
          />
          <!-- Beside the tile, not inside it: a button holds no other controls. The label is the 44 px touch target. -->
          <label
            class="check-target gallery-check"
            @click.stop
          >
            <input
              type="checkbox"
              tabindex="-1"
              :checked="chosen.has(e.path)"
              :aria-label="$t('actions.select', { name: e.name })"
              @click.stop="active = i; toggle(i)"
              @keydown="onCheckKey($event, i)"
            >
          </label>
          <ItemMenu
            :ref="(el) => { if (el) menus.set(i, el as InstanceType<typeof ItemMenu>) }"
            class="gallery-menu"
            :label="$t('actions.menu', { name: e.name })"
            :items="itemsFor(e)"
            :heading="headingFor(e)"
            @select="fromMenu(i, $event)"
            @closed="focusTile(i)"
          />
        </li>
      </template>
    </template>
  </ul>
</template>
