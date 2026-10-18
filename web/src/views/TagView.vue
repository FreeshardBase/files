<script setup lang="ts">
// The tag view (#212): every item of the member that carries one tag, across their sources, in the order they were
// tagged. Each item is looked up in its own source on open: one that is there opens (a folder itself, a file its folder
// with the file selected); one moved or deleted outside Files shows as missing, one whose source is gone as unavailable,
// one whose source failed with the reason. Any of them can lose the tag. Only the first page of items is resolved; a
// note says so when the tag has more (#307).
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { TagItem, TagItemList } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { folderRoute } from '../api/paths.ts';
import { parentOf, useLocations } from '../location.ts';
import { hasThumbnail, pageThumb, thumbnailHref } from '../preview.ts';
import { useTagsStore } from '../stores/tags.ts';
import RowSkeleton from '../components/RowSkeleton.vue';

const { t } = useI18n();
const route = useRoute();
const tags = useTagsStore();
const { folderLabel } = useLocations();
const name = computed(() => String(route.params.name));
const list = ref<TagItemList | null>(null);
const error = ref<ApiFailure | null>(null);
// How many items the server answered (its page); removing a tag here does not change what "the first n" were.
const shownCount = ref(0);
const status = ref('');
const failure = ref('');
const title = ref<HTMLElement>();
const thumbFailed = reactive(new Set<string>());
let seq = 0;

async function load() {
  const id = ++seq;
  error.value = null;
  try {
    const r = await api.get<TagItemList>('/api/v1/tags/items', { name: name.value });
    if (id === seq) { list.value = r; shownCount.value = r.items.length; }
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    if (id === seq) { error.value = e; list.value = null; }
  }
}
watch(name, () => { list.value = null; status.value = ''; failure.value = ''; void load(); }, { immediate: true });

const key = (i: TagItem) => `${i.source} ${i.path}`;
const location = (i: TagItem) => folderLabel(i.source, parentOf(i.path));
const target = (i: TagItem) => i.type === 'directory' ? folderRoute(i.source, i.path)
  : { path: folderRoute(i.source, parentOf(i.path)), query: { select: i.path } };
const note = (i: TagItem) => i.state === 'missing' ? t('tags.missing') : i.state === 'unavailable' ? t('favourites.unavailable')
  : i.state === 'failed' ? t('tags.failed', { reason: t(`errors.${i.error?.code ?? 'INTERNAL'}`) }) : '';

async function untag(i: TagItem) {
  failure.value = '';
  try {
    await tags.remove(i.source, i.path, list.value!.name);
    list.value = { ...list.value!, items: list.value!.items.filter((x) => key(x) !== key(i)) };
    status.value = t('tags.removed', { tag: list.value.name, name: i.name });
    title.value?.focus(); // the row and its button are gone
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    failure.value = t(`errors.${e.code}`);
  }
}
</script>

<template>
  <section class="page tag-view">
    <div class="toolbar">
      <h1
        ref="title"
        class="view-title"
        tabindex="-1"
      >
        <span
          class="tag-dot tag-dot-title"
          :data-color="list?.color"
          aria-hidden="true"
        />
        {{ $t('tags.viewTitle', { tag: list?.name ?? name }) }}
      </h1>
    </div>
    <p
      class="status"
      role="status"
      aria-live="polite"
    >
      {{ status }}
    </p>
    <p
      v-if="failure"
      role="alert"
    >
      {{ failure }}
    </p>
    <p
      v-if="error"
      role="alert"
    >
      {{ $t(`errors.${error.code}`) }}
    </p>
    <RowSkeleton v-else-if="!list" />
    <p
      v-else-if="list.items.length === 0"
      class="favourites-empty"
    >
      {{ $t('tags.empty') }}
    </p>
    <table
      v-else
      class="file-list trash-list favourites-list tag-list"
      :aria-label="$t('tags.viewTitle', { tag: list.name })"
    >
      <thead>
        <tr>
          <th scope="col">
            {{ $t('favourites.columns.name') }}
          </th>
          <th scope="col">
            {{ $t('favourites.columns.location') }}
          </th>
          <th scope="col">
            <span class="visually-hidden">{{ $t('favourites.columns.actions') }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="i in list.items"
          :key="key(i)"
          :data-type="i.type"
          :data-state="i.state"
        >
          <td class="name">
            <div class="name-inner">
              <img
                v-if="i.entry && hasThumbnail(i.entry) && !thumbFailed.has(key(i))"
                class="row-thumb"
                :data-page="pageThumb(i.entry)"
                :src="thumbnailHref(i.source, i.entry, 128)"
                alt=""
                loading="lazy"
                @error="thumbFailed.add(key(i))"
              >
              <span
                v-else
                class="icon"
                :class="i.type === 'directory' ? 'icon-folder' : 'icon-file'"
                aria-hidden="true"
              />
              <span
                class="name-text"
                :title="i.name"
              >{{ i.name }}</span>
            </div>
          </td>
          <td class="origin">
            <span
              class="origin-text"
              :title="location(i)"
            >{{ location(i) }}</span>
            <span
              v-if="i.state !== 'ok'"
              class="favourite-unavailable"
            >{{ note(i) }}</span>
          </td>
          <td class="actions">
            <RouterLink
              v-if="i.state === 'ok'"
              class="button"
              :to="target(i)"
              :aria-label="$t('favourites.openLabel', { name: i.name })"
            >
              {{ $t('favourites.open') }}
            </RouterLink>
            <button
              type="button"
              class="button"
              :aria-label="$t('tags.removeFrom', { tag: list.name, name: i.name })"
              @click="untag(i)"
            >
              {{ $t('tags.removeShort') }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p
      v-if="!error && list?.more"
      class="search-note"
    >
      {{ $t('tags.truncated', { count: shownCount }) }}
    </p>
  </section>
</template>
