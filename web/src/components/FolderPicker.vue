<script setup lang="ts">
// A folder browser inside a page (#153, the migration wizard): the subfolders of one folder of a source as buttons, and
// crumbs back up. Opening a folder chooses it; the folder shown is the choice (`v-model`, a path).
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Entry, ListResponse } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { sourceApi } from '../api/paths.ts';

const props = defineProps<{ source: string; rootLabel: string; label: string }>();
const path = defineModel<string>({ required: true });
const { t } = useI18n();
const folders = ref<Entry[]>([]);
const loading = ref(false);
const error = ref('');
let seq = 0; // only the newest listing may touch the state

async function load() {
  const id = ++seq;
  loading.value = true; error.value = '';
  try {
    const all: Entry[] = []; let cursor: string | undefined;
    do {
      const page: ListResponse = await api.get(`${sourceApi(props.source)}/list`, cursor ? { path: path.value, cursor } : { path: path.value });
      all.push(...page.entries); cursor = page.next;
    } while (cursor);
    if (id !== seq) return;
    folders.value = all.filter((e) => e.type === 'directory').sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    if (id === seq) { folders.value = []; error.value = t(`errors.${e.code}`); }
  } finally {
    if (id === seq) loading.value = false;
  }
}
watch(() => [props.source, path.value], load, { immediate: true });

const crumbs = computed(() => {
  const segs = path.value.split('/').filter(Boolean);
  return [{ label: props.rootLabel, path: '/' }, ...segs.map((s, i) => ({ label: s, path: '/' + segs.slice(0, i + 1).join('/') }))];
});
// The button that had the focus is gone after the re-render; the current crumb takes it, so it stays in the picker (and
// inside the dialog where there is one) instead of falling to <body> (#366, as #356 in MoveToDialog).
const crumbNav = ref<HTMLElement | null>(null);
async function go(p: string) {
  path.value = p;
  await nextTick();
  crumbNav.value?.querySelector<HTMLElement>('[aria-current="location"]')?.focus();
}
const open = (name: string) => go(path.value === '/' ? `/${name}` : `${path.value}/${name}`);
</script>

<template>
  <div class="folder-picker">
    <nav
      ref="crumbNav"
      class="breadcrumbs picker-crumbs"
      :aria-label="label"
    >
      <template
        v-for="(c, i) in crumbs"
        :key="c.path"
      >
        <span
          v-if="i > 0"
          class="sep"
          aria-hidden="true"
        >/</span>
        <button
          type="button"
          class="crumb"
          :aria-current="i === crumbs.length - 1 ? 'location' : undefined"
          @click="go(c.path)"
        >
          {{ c.label }}
        </button>
      </template>
    </nav>
    <p v-if="loading">
      {{ t('folder.loading') }}
    </p>
    <p
      v-else-if="error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-else-if="folders.length === 0"
      class="trash-note"
    >
      {{ t('migrate.noSubfolders') }}
    </p>
    <ul
      v-else
      class="picker-list"
    >
      <li
        v-for="f in folders"
        :key="f.name"
      >
        <button
          type="button"
          class="picker-folder"
          @click="open(f.name)"
        >
          <span
            class="icon icon-folder"
            aria-hidden="true"
          />
          {{ f.name }}
        </button>
      </li>
    </ul>
  </div>
</template>
