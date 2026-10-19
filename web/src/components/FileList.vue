<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { DEFAULT_SORT, SORT_KEYS, type Entry, type Sort, type SortKey } from '@files/shared';
import { formatDate, formatEntrySize, intlLocale } from '../format.ts';
import { downloadHref } from '../api/paths.ts';
import { acceptDrag, drag, droppedPaths, springLeave, springOver, startDrag, type DropMode } from '../dnd.ts';
import { hasThumbnail, pageThumb, thumbnailHref } from '../preview.ts';
import { useWindowedRows, WINDOW_FROM, type Slot } from '../virtual.ts';
import { useItemActions, useLongPress, wantsNativeMenu, type ItemAction } from '../itemActions.ts';
import ItemMenu from './ItemMenu.vue';
import NameText from './NameText.vue';
import TagChips from './TagChips.vue';

// `editable`: the caller may change the source (their home, an edit share); otherwise only download and details are
// offered, the change keys do nothing and rows are not dragged. `shareable`: the items are the caller's own (#146).
// `starred`: the paths of this source that are favourites (#155); every row has the star toggle.
// `sort`: the order `entries` are in (#226); the column headers are buttons that emit `sort` with their key. On a phone
// the header row is hidden and the folder's sort menu is the control; the header keeps a plain label for screen readers.
// Large folders (#225): only the rows near the viewport are in the DOM (`useWindowedRows`); the table carries
// aria-rowcount and every row its aria-rowindex, so assistive technology still counts the whole folder.
// `tags`: the member's tags by path (#212), shown as chips after the name; each opens the tag view.
// `comments`: comment counts by path (#213), a badge after the chips; the thread is in the details drawer.
// `toOther`: a second pane takes items (#218); the item menu then offers to copy (and move) them there.
const props = withDefaults(defineProps<{ entries: Entry[]; folderName: string; source?: string; selected?: string[];
  editable?: boolean; shareable?: boolean; starred?: string[]; sort?: Sort; tags?: Record<string, string[]>;
  comments?: Record<string, number>; toOther?: boolean }>(),
{ source: 'home', selected: () => [], editable: true, shareable: false, starred: () => [], sort: () => ({ ...DEFAULT_SORT }),
  tags: () => ({}), comments: () => ({}), toOther: false });
const emit = defineEmits<{
  open: [Entry]; 'update:selected': [string[]]; action: [ItemAction, Entry[], HTMLElement?]; paste: []; drop: [string[], string, string, DropMode];
  sort: [SortKey]; openTab: [Entry]; spring: [Entry];
}>();
const { locale } = useI18n();
const active = ref(0);
const body = ref<HTMLElement>();
// The menus of the rendered rows by row index, collected anew on every render.
const menus = new Map<number, InstanceType<typeof ItemMenu>>();
onBeforeUpdate(() => menus.clear());
const dropTarget = ref<string | null>(null);

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

// Selection, the item menu and the action keys are the gallery's too (#229).
const { chosen, toggle, targets, itemsFor, headingFor, selectForMenu, isFavourite, fromMenu, onActionKey, onSelectClick } = useItemActions(props, {
  open: (e) => emit('open', e), select: (paths) => emit('update:selected', paths), action: (...args) => emit('action', ...args),
  paste: () => emit('paste'),
}, { showMenu: (i) => { void menus.get(i)?.show(); }, menuButton: (i) => menus.get(i)?.trigger });

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
  const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: props.entries.length - 1 }[e.key];
  if (to === undefined) { onActionKey(e, i); return; }
  e.preventDefault();
  void focusRow(to);
}
function onClick(e: MouseEvent, i: number) {
  active.value = i;
  onSelectClick(e, i);
}
// A plain click on a file's name previews it; the link itself (new tab, save link as) still downloads.
function onFileClick(e: MouseEvent, entry: Entry) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  emit('open', entry);
}
// The context menu and a long-press (#160) open the row's menu; on a row outside the selection, after selecting only it
// (#340). The browser keeps its own menu over selected text and in the row's checkbox.
function showMenu(i: number) {
  active.value = i;
  selectForMenu(i);
  void menus.get(i)?.show();
}
function onContextMenu(e: MouseEvent, i: number) {
  if (wantsNativeMenu(e)) return;
  e.preventDefault();
  showMenu(i);
}
const press = useLongPress(showMenu);
// A folder row takes dragged items (#338) and, held under them, asks to be opened; never a folder that is itself dragged.
watch(() => drag.items, (i) => { if (!i) dropTarget.value = null; }); // ended or cancelled without a leave
const dragged = (entry: Entry) => drag.items?.source === props.source && drag.items.paths.includes(entry.path);
function onDragOver(e: DragEvent, entry: Entry) {
  if (entry.type !== 'directory' || dragged(entry)) return;
  springOver(e, `row:${props.source}:${entry.path}`, () => emit('spring', entry));
  if (props.editable && acceptDrag(e, props.source, entry.name)) dropTarget.value = entry.path;
}
function onDragLeave(e: DragEvent, entry: Entry) {
  springLeave(e, `row:${props.source}:${entry.path}`);
  dropTarget.value = dropTarget.value === entry.path ? null : dropTarget.value;
}
function onDrop(e: DragEvent, entry: Entry) {
  dropTarget.value = null;
  if (!props.editable || entry.type !== 'directory') return;
  const items = droppedPaths(e, props.source);
  if (items) {
    emit('drop', items.paths.filter((p) => items.source !== props.source || p !== entry.path), entry.path, items.source, items.mode);
  }
}
// A middle click on a folder (#219) asks for it in a new tab; the folder view decides whether there are tabs.
function onAuxClick(e: MouseEvent, entry: Entry) {
  if (e.button !== 1 || entry.type !== 'directory') return;
  e.preventDefault();
  emit('openTab', entry);
}

// A thumbnail that could not be loaded falls back to the line icon instead of a broken image.
const thumbFailed = reactive(new Set<string>());
const sizeText = (e: Entry) => (e.type === 'file' ? formatEntrySize(e, intlLocale(locale.value)) : '');
const fileHref = (e: Entry) => downloadHref(props.source, [e]);
</script>

<template>
  <table
    class="file-list folder-list"
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
            @click.capture="press.onClickCapture"
            @click="onClick($event, i)"
            @pointerdown="press.onPointerDown($event, i)"
            @pointermove="press.onPointerMove"
            @pointerup="press.onPointerUp"
            @pointercancel="press.onPointerUp"
            @focusin="active = i"
            @keydown="onKey($event, i)"
            @dblclick="emit('open', e)"
            @contextmenu="onContextMenu($event, i)"
            @dragstart="startDrag($event, source, targets(i).map((x) => x.path))"
            @auxclick="onAuxClick($event, e)"
            @dragenter="onDragOver($event, e)"
            @dragover="onDragOver($event, e)"
            @dragleave="onDragLeave($event, e)"
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
                  :data-page="pageThumb(e)"
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
                ><NameText :name="e.name" /></a>
                <button
                  v-else
                  type="button"
                  class="link"
                  tabindex="-1"
                  @click="emit('open', e)"
                >
                  <NameText :name="e.name" />
                </button>
                <TagChips
                  :tags="tags[e.path] ?? []"
                  :name="e.name"
                  in-row
                />
                <span
                  v-if="comments[e.path]"
                  class="comment-badge"
                  :title="$t('comments.count', { count: comments[e.path] }, comments[e.path]!)"
                >
                  <span
                    class="icon icon-comment"
                    aria-hidden="true"
                  />
                  <span aria-hidden="true">{{ comments[e.path] }}</span>
                  <span class="visually-hidden">{{ $t('comments.count', { count: comments[e.path] }, comments[e.path]!) }}</span>
                </span>
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
                :heading="headingFor(e)"
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
