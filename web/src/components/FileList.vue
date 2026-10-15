<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Entry } from '@files/shared';
import { formatDate, formatSize, intlLocale } from '../format.ts';
import { downloadHref } from '../api/paths.ts';
import { acceptDrag, droppedPaths, startDrag } from '../dnd.ts';
import ItemMenu from './ItemMenu.vue';

export type ItemAction = 'download' | 'rename' | 'cut' | 'copy' | 'trash';
const props = withDefaults(defineProps<{ entries: Entry[]; folderName: string; source?: string; selected?: string[] }>(),
  { source: 'home', selected: () => [] });
const emit = defineEmits<{
  open: [Entry]; 'update:selected': [string[]]; action: [ItemAction, Entry[]]; paste: []; drop: [string[], string];
}>();
const { locale, t } = useI18n();
const active = ref(0);
const rows = ref<HTMLElement[]>([]);
const menus = ref<InstanceType<typeof ItemMenu>[]>([]);
const dropTarget = ref<string | null>(null);
let anchor = 0; // where a Shift+click range starts

// Drop stale row refs and keep the roving tab stop inside the list when it shrinks.
watch(() => props.entries.length, (n) => {
  rows.value.length = n; menus.value.length = n;
  active.value = Math.max(0, Math.min(active.value, n - 1));
});

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

const menuItems = computed(() => (['download', 'rename', 'cut', 'copy', 'trash'] as const).map((id) => ({ id, label: t(`actions.${id}`) })));
function fromMenu(i: number, id: string) { emit('action', id as ItemAction, id === 'rename' ? [props.entries[i]!] : targets(i)); }

function focusRow(i: number) {
  active.value = Math.max(0, Math.min(props.entries.length - 1, i));
  rows.value[active.value]?.focus();
}
defineExpose({
  focus: () => focusRow(active.value), // after an action took the focused row away
  focusPath: (path: string) => { const i = props.entries.findIndex((e) => e.path === path); if (i >= 0) focusRow(i); }, // after the preview
});
function onKey(e: KeyboardEvent, i: number) {
  if (e.target !== e.currentTarget) return; // keys inside the row's own controls belong to them
  const entry = props.entries[i]!;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const handled = () => { e.preventDefault(); return true; };
  if (key === 'ArrowDown' && handled()) focusRow(i + 1);
  else if (key === 'ArrowUp' && handled()) focusRow(i - 1);
  else if (key === ' ' && handled()) toggle(i);
  else if (key === 'F2' && handled()) emit('action', 'rename', [entry]);
  else if (key === 'Delete' && handled()) emit('action', 'trash', targets(i));
  else if (mod && key === 'c' && handled()) emit('action', 'copy', targets(i));
  else if (mod && key === 'x' && handled()) emit('action', 'cut', targets(i));
  else if (mod && key === 'v' && handled()) emit('paste');
  else if (mod && key === 'a' && handled()) select(props.entries.map((x) => x.path));
  else if ((key === 'ContextMenu' || (key === 'F10' && e.shiftKey)) && handled()) void menus.value[i]?.show();
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
  void menus.value[i]?.show();
}
function onDragOver(e: DragEvent, entry: Entry) {
  if (entry.type === 'directory' && acceptDrag(e)) dropTarget.value = entry.path;
}
function onDrop(e: DragEvent, entry: Entry) {
  dropTarget.value = null;
  if (entry.type !== 'directory') return;
  const paths = droppedPaths(e);
  if (paths) emit('drop', paths.filter((p) => p !== entry.path), entry.path);
}

const sizeText = (e: Entry) => (e.type === 'file' ? formatSize(e.size, intlLocale(locale.value)) : '');
const fileHref = (e: Entry) => downloadHref(props.source, [e]);
</script>

<template>
  <table
    class="file-list"
    role="table"
    :aria-label="$t('a11y.fileList', { folder: folderName })"
  >
    <thead role="rowgroup">
      <tr role="row">
        <th
          scope="col"
          role="columnheader"
          class="select"
        >
          <span class="visually-hidden">{{ $t('actions.selectColumn') }}</span>
        </th><th
          scope="col"
          role="columnheader"
        >
          {{ $t('folder.columns.name') }}
        </th><th
          scope="col"
          role="columnheader"
        >
          {{ $t('folder.columns.size') }}
        </th><th
          scope="col"
          role="columnheader"
        >
          {{ $t('folder.columns.modified') }}
        </th><th
          scope="col"
          role="columnheader"
          class="menu-cell"
        >
          <span class="visually-hidden">{{ $t('actions.column') }}</span>
        </th>
      </tr>
    </thead>
    <tbody role="rowgroup">
      <tr
        v-for="(e, i) in entries"
        :key="e.path"
        :ref="(el) => { if (el) rows[i] = el as HTMLElement }"
        role="row"
        :tabindex="i === active ? 0 : -1"
        :data-type="e.type"
        :aria-selected="chosen.has(e.path)"
        :class="{ selected: chosen.has(e.path), 'drop-target': dropTarget === e.path }"
        draggable="true"
        @click="onClick($event, i)"
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
          <input
            type="checkbox"
            tabindex="-1"
            :checked="chosen.has(e.path)"
            :aria-label="$t('actions.select', { name: e.name })"
            @click.stop="active = i; toggle(i)"
          >
        </td>
        <td
          class="name"
          role="cell"
        >
          <div class="name-inner">
            <span
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
          {{ formatDate(e.modified, intlLocale(locale)) }}
        </td>
        <td
          class="menu-cell"
          role="cell"
        >
          <ItemMenu
            :ref="(el) => { if (el) menus[i] = el as InstanceType<typeof ItemMenu> }"
            :label="$t('actions.menu', { name: e.name })"
            :items="menuItems"
            @select="fromMenu(i, $event)"
            @closed="focusRow(i)"
          />
        </td>
      </tr>
    </tbody>
  </table>
</template>
