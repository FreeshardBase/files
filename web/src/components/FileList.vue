<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Entry } from '@files/shared';
import { formatDate, formatSize, intlLocale } from '../format.ts';

const props = defineProps<{ entries: Entry[]; folderName: string }>();
const emit = defineEmits<{ open: [Entry] }>();
const { locale } = useI18n();
const active = ref(0);
const rows = ref<HTMLElement[]>([]);

function focusRow(i: number) {
  active.value = Math.max(0, Math.min(props.entries.length - 1, i));
  rows.value[active.value]?.focus();
}
function onKey(e: KeyboardEvent, i: number) {
  if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(i + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(i - 1); }
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
    :aria-label="$t('a11y.fileList', { folder: folderName })"
  >
    <thead>
      <tr>
        <th scope="col">
          {{ $t('folder.columns.name') }}
        </th><th scope="col">
          {{ $t('folder.columns.size') }}
        </th><th scope="col">
          {{ $t('folder.columns.modified') }}
        </th>
      </tr>
    </thead>
    <tbody>
      <tr
        v-for="(e, i) in entries"
        :key="e.path"
        :ref="(el) => { if (el) rows[i] = el as HTMLElement }"
        :tabindex="i === active ? 0 : -1"
        :data-type="e.type"
        @keydown="onKey($event, i)"
        @dblclick="emit('open', e)"
      >
        <td class="name">
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
        <td class="num">
          {{ sizeText(e) }}
        </td>
        <td class="num">
          {{ formatDate(e.modified, intlLocale(locale)) }}
        </td>
      </tr>
    </tbody>
  </table>
</template>
