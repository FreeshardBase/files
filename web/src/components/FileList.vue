<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Entry } from '@files/shared';
import { formatDate, formatSize, intlLocale } from '../format.ts';

const props = defineProps<{ entries: Entry[]; folderName: string }>();
const emit = defineEmits<{ open: [Entry] }>();
const { locale } = useI18n();
const active = ref(0);
const rows = ref<HTMLElement[]>([]);

// Drop stale row refs and keep the roving tab stop inside the list when it shrinks.
watch(() => props.entries.length, (n) => {
  rows.value.length = n;
  active.value = Math.max(0, Math.min(active.value, n - 1));
});

function focusRow(i: number) {
  active.value = Math.max(0, Math.min(props.entries.length - 1, i));
  rows.value[active.value]?.focus();
}
function onKey(e: KeyboardEvent, i: number) {
  if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(i + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(i - 1); }
  else if (e.key === ' ' && props.entries[i]!.type === 'directory') { e.preventDefault(); emit('open', props.entries[i]!); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const entry = props.entries[i]!;
    // A file's Enter is a download: the row's own link does it, same as a click.
    if (entry.type === 'file') rows.value[i]?.querySelector('a')?.click();
    else emit('open', entry);
  }
}
const sizeText = (e: Entry) => (e.type === 'file' ? formatSize(e.size, intlLocale(locale.value)) : '');
const downloadHref = (e: Entry) => `/api/v1/sources/home/content?path=${encodeURIComponent(e.path)}&download=1`;
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
        @click="active = i"
        @focusin="active = i"
        @keydown="onKey($event, i)"
        @dblclick="emit('open', e)"
      >
        <td
          class="name"
          role="cell"
        >
          <span
            class="icon"
            :class="e.type === 'directory' ? 'icon-folder' : 'icon-file'"
            aria-hidden="true"
          />
          <a
            v-if="e.type === 'file'"
            :href="downloadHref(e)"
            tabindex="-1"
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
        </td>
        <td
          class="num"
          role="cell"
        >
          {{ sizeText(e) }}
        </td>
        <td
          class="num"
          role="cell"
        >
          {{ formatDate(e.modified, intlLocale(locale)) }}
        </td>
      </tr>
    </tbody>
  </table>
</template>
