<script setup lang="ts">
// The versions of one file in the details drawer (#154): newest first, with date and size. The home's versions can be
// downloaded; with `edit`, every version that is not the file itself can be restored (the content it replaces is kept
// as a version, so a restore never loses anything). A source that keeps no versions leaves the section out. Times show
// seconds, so versions saved within one minute stay apart; the download is an icon button (#242).
import { computed, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Entry, Version, VersionList } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { formatDateSeconds, formatSize, intlLocale } from '../format.ts';

const props = defineProps<{ source: string; entry: Entry }>();
const emit = defineEmits<{ restored: [entry: Entry] }>();
const { t, locale } = useI18n();
const list = ref<VersionList | null>(null);
const unsupported = ref(false);
const error = ref('');
const message = ref('');
const busy = ref(false);
const headingId = useId();
const newestFirst = computed(() => [...(list.value?.versions ?? [])].reverse());
const when = (v: Version) => formatDateSeconds(v.modified, intlLocale(locale.value));
const href = (v: Version) => `/api/v1/versions/content?${new URLSearchParams({ source: props.source, path: props.entry.path, id: v.id })}`;

async function load() {
  try {
    list.value = await api.get<VersionList>('/api/v1/versions', { source: props.source, path: props.entry.path });
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    if (e.code === 'NOT_SUPPORTED') unsupported.value = true;
    else error.value = t(`errors.${e.code}`);
  }
}

async function restore(v: Version) {
  busy.value = true; error.value = ''; message.value = '';
  try {
    const entry = await api.post<Entry>('/api/v1/versions/restore', { source: props.source, path: props.entry.path, id: v.id });
    message.value = t('versions.restored', { date: when(v) });
    emit('restored', entry);
    await load();
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    error.value = t(`errors.${e.code}`);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section v-if="!unsupported">
    <h3
      :id="headingId"
      class="share-heading"
    >
      {{ t('versions.title') }}
    </h3>
    <p
      role="status"
      class="share-note"
    >
      {{ message }}
    </p>
    <p
      v-if="error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-else-if="!list"
      class="share-note"
    >
      {{ t('versions.loading') }}
    </p>
    <ul
      v-else-if="newestFirst.length"
      class="share-list"
      :aria-labelledby="headingId"
    >
      <li
        v-for="v in newestFirst"
        :key="v.id"
      >
        <span class="share-name value-mono">{{ when(v) }}</span>
        <span
          v-if="v.size !== undefined"
          class="share-level value-mono"
        >{{ formatSize(v.size, intlLocale(locale)) }}</span>
        <span
          v-if="v.current"
          class="share-level"
        >{{ t('versions.current') }}</span>
        <span
          v-else-if="list.download || list.restore"
          class="link-buttons"
        >
          <a
            v-if="list.download"
            class="icon-button row-icon-button"
            :href="href(v)"
            download
            :aria-label="t('versions.downloadLabel', { date: when(v) })"
          ><span
            class="icon icon-download"
            aria-hidden="true"
          /></a>
          <button
            v-if="list.restore"
            type="button"
            class="button"
            :disabled="busy"
            :aria-label="t('versions.restoreLabel', { date: when(v) })"
            @click="restore(v)"
          >
            {{ t('versions.restore') }}
          </button>
        </span>
      </li>
    </ul>
    <p
      v-else
      class="share-note"
    >
      {{ t('versions.none') }}
    </p>
  </section>
</template>
