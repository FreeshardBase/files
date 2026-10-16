<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { DEFAULT_SORT, SORT_KEYS, type Entry, type Sort, type SortKey } from '@files/shared';
import { formatDate, formatSize, intlLocale } from '../format.ts';
import { downloadHref } from '../api/paths.ts';
import { acceptDrag, droppedPaths, startDrag } from '../dnd.ts';
import { hasThumbnail, thumbnailHref } from '../preview.ts';
import { useWindowedRows, WINDOW_FROM, type Slot } from '../virtual.ts';
import ItemMenu from './ItemMenu.vue';

export type ItemAction = 'download' | 'favourite' | 'share' | 'details' | 'rename' | 'cut' | 'copy' | 'trash';
// `editable`: the caller may change the source (their home, an edit share); otherwise only download and details are
// offered, the change keys do nothing and rows are not dragged. `shareable`: the items are the caller's own (#146).
// `starred`: the paths of this source that are favourites (#155); every row has the star toggle.
// `sort`: the order `entries` are in (#226); the column headers are buttons that emit `sort` with their key. On a phone
// the header row is hidden and the folder's sort menu is the control; the header keeps a plain label for screen readers.
// Large folders (#225): only the rows near the viewport are in the DOM (`useWindowedRows`); the table carries
// aria-rowcount and every row its aria-rowindex, so assistive technology still counts the whole folder.
const props = withDefaults(defineProps<{ entries: Entry[]; folderName: string; source?: string; selected?: string[];
  editable?: boolean; shareable?: boolean; starred?: string[]; sort?: Sort }>(),
{ source: 'home', selected: () => [], editable: true, shareable: false, starred: () => [], sort: () => ({ ...DEFAULT_SORT }) });
const emit = defineEmits<{
  open: [Entry]; 'update:selected': [string[]]; action: [ItemAction, Entry[]]; paste: []; drop: [string[], string];
  sort: [SortKey];
}>();
const { locale, t } = useI18n();
const active = ref(0);
const body = ref<HTMLElement>();
// The menus of the rendered rows by row index, collected anew on every render.
const menus = new Map<number, InstanceType<typeof ItemMenu>>();
onBeforeUpdate(() => menus.clear());
const dropTarget = ref<string | null>(null);
let anchor = 0; // where a Shift+click range starts

// Keep the roving tab stop inside the list when it shrinks.
watch(() => props.entries.length, (n) => {
  active.value = Math.max(0, Math.min(active.value, n - 1));
});

// Row heights by path, measured once rendered; a row not rendered yet counts as tall as the first one measured. A long
// name wraps, so rows can differ. The estimate stays fixed: following the rows just measured would move the window,
// which renders other rows, which moves the estimate again. A new width (a turned phone) measures afresh.
const heights = reactive(new Map<string, number>());
const typical = ref(48);
function measure() {
  for (const tr of body.value?.querySelectorAll<HTMLElement>('tr[aria-rowindex]') ?? []) {
    const e = props.entries[Number(tr.getAttribute('aria-rowindex')) - 2];
    const h = tr.getBoundingClientRect().height;
    if (!e || h <= 0) continue;
    if (!heights.size) typical.value = h;
    if (Math.abs((heights.get(e.path) ?? 0) - h) > 0.5) heights.set(e.path, h);
  }
}
let width = 0;
function onResize() {
  if (innerWidth === width) return;
  width = innerWidth; heights.clear(); measure();
}
onMounted(() => { width = innerWidth; measure(); addEventListener('resize', onResize); });
onBeforeUnmount(() => removeEventListener('resize', onResize));
onUpdated(measure);
const { slots } = useWindowedRows(body, {
  count: () => props.entries.length, size: (i) => heights.get(props.entries[i]!.path) ?? typical.value, pinned: () => active.value,
  whole: () => props.entries.length <= WINDOW_FROM,
});
// What the body renders: spacers and rows, each with a key of its own.
type Item = { kind: 'gap'; key: string; size: number; e?: undefined; i?: undefined }
  | { kind: 'row'; key: string; size?: undefined; e: Entry; i: number };
const items = computed(() => slots.value.map((s: Slot): Item => (s.row === undefined
  ? { kind: 'gap', key: s.key, size: s.size }
  : { kind: 'row', key: props.entries[s.row]!.path, e: props.entries[s.row]!, i: s.row })));
const rowEl = (i: number) => body.value?.querySelector<HTMLElement>(`tr[aria-rowindex="${i + 2}"]`);

const chosen = computed(() => new Set(props.selected));
const select = (paths: string[]) => emit('update:selected', paths);
function toggle(i: number) {
  anchor = i;
  const p = props.entries[i]!.path;
  select(chosen.value.has(p) ? props.selected.filter((x) => x !== p) : [...props.selected, p]);
}
function selectRange(i: number) {
  const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
  select(props.entries.slice(a, b + 1).map((e) => e.path));
}
// An action on a row applies to the whole selection if the row is part of it, else to the row alone.
const targets = (i: number): Entry[] => chosen.value.has(props.entries[i]!.path) ? props.entries.filter((e) => chosen.value.has(e.path)) : [props.entries[i]!];

// The destructive action stays last; favourite, share and details sit between the file actions and it.
const menuItems = computed(() => ([
  'download', ...(props.editable ? ['rename', 'cut', 'copy'] as const : []), 'favourite',
  ...(props.shareable ? ['share'] as const : []), 'details', ...(props.editable ? ['trash'] as const : []),
] as const).map((id) => ({ id, label: t(`actions.${id}`) })));
// The favourite entry says what choosing it does to this row (#155).
const starredSet = computed(() => new Set(props.starred));
const isFavourite = (e: Entry) => starredSet.value.has(e.path);
const itemsFor = (e: Entry) => menuItems.value.map((m) => m.id === 'favourite'
  ? { id: m.id, label: t(isFavourite(e) ? 'favourites.remove' : 'favourites.add') } : m);
// Rename, favourite, share and details act on the row itself, never on the whole selection.
const SINGLE = new Set(['rename', 'favourite', 'share', 'details']);
function fromMenu(i: number, id: string) { emit('action', id as ItemAction, SINGLE.has(id) ? [props.entries[i]!] : targets(i)); }

// The row becomes the tab stop, which is always rendered; focusing it scrolls it into view.
async function focusRow(i: number) {
  active.value = Math.max(0, Math.min(props.entries.length - 1, i));
  const at = active.value;
  if (!rowEl(at)) await nextTick();
  if (active.value === at) rowEl(at)?.focus();
}
defineExpose({
  focus: () => { void focusRow(active.value); }, // after an action took the focused row away
  focusPath: (path: string) => { const i = props.entries.findIndex((e) => e.path === path); if (i >= 0) void focusRow(i); }, // after the preview
});
function onKey(e: KeyboardEvent, i: number) {
  if (e.target !== e.currentTarget) return; // keys inside the row's own controls belong to them
  const entry = props.entries[i]!;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const handled = () => { e.preventDefault(); return true; };
  if (key === 'ArrowDown' && handled()) void focusRow(i + 1);
  else if (key === 'ArrowUp' && handled()) void focusRow(i - 1);
  else if (key === 'Home' && handled()) void focusRow(0);
  else if (key === 'End' && handled()) void focusRow(props.entries.length - 1);
  else if (key === ' ' && handled()) toggle(i);
  else if (props.editable && key === 'F2' && handled()) emit('action', 'rename', [entry]);
  else if (props.editable && key === 'Delete' && handled()) emit('action', 'trash', targets(i));
  else if (props.editable && mod && key === 'c' && handled()) emit('action', 'copy', targets(i));
  else if (props.editable && mod && key === 'x' && handled()) emit('action', 'cut', targets(i));
  else if (props.editable && mod && key === 'v' && handled()) emit('paste');
  else if (mod && key === 'a' && handled()) select(props.entries.map((x) => x.path));
  else if ((key === 'ContextMenu' || (key === 'F10' && e.shiftKey)) && handled()) void menus.get(i)?.show();
  else if (key === 'Enter' && handled()) emit('open', entry); // a folder opens, a file opens in the preview
}
function onClick(e: MouseEvent, i: number) {
  active.value = i;
  if (e.shiftKey) selectRange(i);
  else if (e.ctrlKey || e.metaKey) toggle(i);
}
// A plain click on a file's name previews it; the link itself (new tab, save link as) still downloads.
function onFileClick(e: MouseEvent, entry: Entry) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  emit('open', entry);
}
function onContextMenu(e: MouseEvent, i: number) {
  e.preventDefault();
  active.value = i;
  void menus.get(i)?.show();
}
// Long-press (#160): a touch held still for half a second opens the row's menu, as the context menu does with a mouse.
// The click the lifted finger may still produce is swallowed, so the press does not also open or select the item.
const LONG_PRESS_MS = 500;
let press: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
let pressed = false;
function cancelPress() { if (press) clearTimeout(press.timer); press = null; }
function onPointerDown(e: PointerEvent, i: number) {
  cancelPress();
  pressed = false;
  if (e.pointerType !== 'touch' || (e.target instanceof Element && e.target.closest('.item-menu'))) return;
  press = { x: e.clientX, y: e.clientY, timer: setTimeout(() => {
    press = null; pressed = true; active.value = i;
    void menus.get(i)?.show();
  }, LONG_PRESS_MS) };
}
function onPointerMove(e: PointerEvent) {
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress(); // a scroll, not a press
}
function onClickCapture(e: MouseEvent) {
  if (!pressed) return;
  pressed = false;
  e.preventDefault(); e.stopPropagation();
}
onBeforeUnmount(cancelPress);
function onDragOver(e: DragEvent, entry: Entry) {
  if (props.editable && entry.type === 'directory' && acceptDrag(e)) dropTarget.value = entry.path;
}
function onDrop(e: DragEvent, entry: Entry) {
  dropTarget.value = null;
  if (!props.editable || entry.type !== 'directory') return;
  const paths = droppedPaths(e);
  if (paths) emit('drop', paths.filter((p) => p !== entry.path), entry.path);
}

// A thumbnail that could not be loaded falls back to the line icon instead of a broken image.
const thumbFailed = reactive(new Set<string>());
const sizeText = (e: Entry) => (e.type === 'file' ? formatSize(e.size, intlLocale(locale.value)) : '');
const fileHref = (e: Entry) => downloadHref(props.source, [e]);
</script>

<template>
  <table
    class="file-list"
    role="table"
    :aria-label="$t('a11y.fileList', { folder: folderName })"
    :aria-rowcount="entries.length + 1"
  >
    <thead role="rowgroup">
      <tr
        role="row"
        aria-rowindex="1"
      >
        <th
          scope="col"
          role="columnheader"
          class="select"
        >
          <span class="visually-hidden">{{ $t('actions.selectColumn') }}</span>
        </th><th
          v-for="k in SORT_KEYS"
          :key="k"
          scope="col"
          role="columnheader"
          :aria-sort="sort.key === k ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined"
        >
          <button
            type="button"
            class="sort-button"
            @click="emit('sort', k)"
          >
            {{ $t(`folder.columns.${k}`) }}
          </button><span class="sort-label">{{ $t(`folder.columns.${k}`) }}</span>
        </th><th
          scope="col"
          role="columnheader"
          class="star-cell"
        >
          <span class="visually-hidden">{{ $t('favourites.column') }}</span>
        </th><th
          scope="col"
          role="columnheader"
          class="menu-cell"
        >
          <span class="visually-hidden">{{ $t('actions.column') }}</span>
        </th>
      </tr>
    </thead>
    <tbody
      ref="body"
      role="rowgroup"
    >
      <template
        v-for="{ kind, key, size, e, i } in items"
        :key="key"
      >
        <tr
          v-if="kind === 'gap'"
          class="virtual-spacer"
          role="presentation"
          aria-hidden="true"
        >
          <td
            colspan="6"
            :style="{ height: `${size}px` }"
          />
        </tr>
        <template v-else>
          <tr
            role="row"
            :aria-rowindex="i + 2"
            :tabindex="i === active ? 0 : -1"
            :data-type="e.type"
            :aria-selected="chosen.has(e.path)"
            :class="{ selected: chosen.has(e.path), 'drop-target': dropTarget === e.path }"
            :draggable="editable"
            @click.capture="onClickCapture"
            @click="onClick($event, i)"
            @pointerdown="onPointerDown($event, i)"
            @pointermove="onPointerMove"
            @pointerup="cancelPress"
            @pointercancel="cancelPress"
            @focusin="active = i"
            @keydown="onKey($event, i)"
            @dblclick="emit('open', e)"
            @contextmenu="onContextMenu($event, i)"
            @dragstart="startDrag($event, targets(i).map((x) => x.path))"
            @dragover="onDragOver($event, e)"
            @dragleave="dropTarget = dropTarget === e.path ? null : dropTarget"
            @drop="onDrop($event, e)"
          >
            <td
              class="select"
              role="cell"
            >
              <!-- The label is the checkbox's touch target (44 px on a phone); a click on it reaches the box. -->
              <label
                class="check-target"
                @click.stop
              >
                <input
                  type="checkbox"
                  tabindex="-1"
                  :checked="chosen.has(e.path)"
                  :aria-label="$t('actions.select', { name: e.name })"
                  @click.stop="active = i; toggle(i)"
                >
              </label>
            </td>
            <td
              class="name"
              role="cell"
            >
              <div class="name-inner">
                <img
                  v-if="hasThumbnail(e) && !thumbFailed.has(e.path)"
                  class="row-thumb"
                  :src="thumbnailHref(source, e, 128)"
                  alt=""
                  loading="lazy"
                  draggable="false"
                  @error="thumbFailed.add(e.path)"
                >
                <span
                  v-else
                  class="icon"
                  :class="e.type === 'directory' ? 'icon-folder' : 'icon-file'"
                  aria-hidden="true"
                />
                <a
                  v-if="e.type === 'file'"
                  :href="fileHref(e)"
                  tabindex="-1"
                  draggable="false"
                  @click="onFileClick($event, e)"
                >{{ e.name }}</a>
                <button
                  v-else
                  type="button"
                  class="link"
                  tabindex="-1"
                  @click="emit('open', e)"
                >
                  {{ e.name }}
                </button>
              </div>
            </td>
            <td
              class="num size"
              role="cell"
            >
              {{ sizeText(e) }}
            </td>
            <td
              class="num date"
              role="cell"
            >
              <template v-if="e.modified">
                {{ formatDate(e.modified, intlLocale(locale)) }}
              </template>
            </td>
            <td
              class="star-cell"
              role="cell"
            >
              <button
                type="button"
                class="icon-button star-toggle"
                tabindex="-1"
                :aria-label="$t('favourites.toggle', { name: e.name })"
                :aria-pressed="isFavourite(e)"
                @click.stop="emit('action', 'favourite', [e])"
                @dblclick.stop
              >
                <span
                  class="icon"
                  :class="isFavourite(e) ? 'icon-star-filled' : 'icon-star'"
                  aria-hidden="true"
                />
              </button>
            </td>
            <td
              class="menu-cell"
              role="cell"
            >
              <ItemMenu
                :ref="(el) => { if (el) menus.set(i, el as InstanceType<typeof ItemMenu>) }"
                :label="$t('actions.menu', { name: e.name })"
                :items="itemsFor(e)"
                @select="fromMenu(i, $event)"
                @closed="focusRow(i)"
              />
            </td>
          </tr>
        </template>
      </template>
    </tbody>
  </table>
</template>
