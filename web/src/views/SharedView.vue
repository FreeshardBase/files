<script setup lang="ts">
// "Shared with me" (#146): what other members shared with the member, newest first. A folder opens as the source
// `share:<id>`, a file downloads or opens in the preview overlay (#208). A share whose item the owner deleted says so
// and can be removed from the list.
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Entry, IncomingShare } from '@files/shared';
import { useSharedStore } from '../stores/shared.ts';
import { api, ApiFailure } from '../api/client.ts';
import { downloadHref, folderRoute, sourceApi } from '../api/paths.ts';
import PreviewDialog from '../components/PreviewDialog.vue';
import RowSkeleton from '../components/RowSkeleton.vue';
import { formatDate, intlLocale } from '../format.ts';

const { t, locale } = useI18n();
const shared = useSharedStore();
const status = ref('');
onMounted(() => { void shared.load(); });

// A shared file is `/` of its share; its type and size come from the share's own `stat`.
const preview = ref<{ source: string; entry: Entry } | null>(null);
async function openPreview(item: IncomingShare) {
  try { preview.value = { source: item.source, entry: await api.get<Entry>(`${sourceApi(item.source)}/stat`, { path: '/' }) }; }
  catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    status.value = t(`errors.${e.code}`); // handled: shown in the status line
  }
}

async function remove(item: IncomingShare) {
  try {
    await shared.remove(item.id);
    status.value = t('shared.removed', { name: item.name });
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    status.value = t(`errors.${e.code}`);
  }
}
</script>

<template>
  <section class="page recent shared">
    <div class="toolbar">
      <h1
        class="view-title"
        tabindex="-1"
      >
        {{ $t('shared.title') }}
      </h1>
    </div>
    <p
      class="status"
      role="status"
      aria-live="polite"
    >
      {{ status }}
    </p>
    <RowSkeleton v-if="!shared.loaded" />
    <p
      v-else-if="shared.error"
      role="alert"
    >
      {{ $t(`errors.${shared.error.code}`) }}
    </p>
    <p
      v-else-if="shared.items.length === 0"
      class="recent-empty"
    >
      {{ $t('shared.empty') }}
    </p>
    <table
      v-else
      class="file-list trash-list shared-list"
      :aria-label="$t('shared.title')"
    >
      <thead>
        <tr>
          <th scope="col">
            {{ $t('shared.columns.name') }}
          </th>
          <th scope="col">
            {{ $t('shared.columns.owner') }}
          </th>
          <th scope="col">
            {{ $t('shared.columns.access') }}
          </th>
          <th scope="col">
            {{ $t('shared.columns.shared') }}
          </th>
          <th scope="col">
            <span class="visually-hidden">{{ $t('shared.columns.actions') }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="item in shared.items"
          :key="item.id"
          :data-type="item.type"
        >
          <td class="name">
            <div class="name-inner">
              <span
                class="icon"
                :class="item.type === 'directory' ? 'icon-folder' : 'icon-file'"
                aria-hidden="true"
              />
              <span
                class="name-text"
                :title="item.name"
              >{{ item.name }}</span>
            </div>
          </td>
          <td class="origin">
            {{ item.owner.displayName }}
          </td>
          <td class="origin">
            <span
              class="fs-pill"
              :data-tone="item.orphaned ? 'danger' : undefined"
            >{{ item.orphaned ? $t('shared.orphaned') : $t(`share.${item.access}`) }}</span>
          </td>
          <td class="num date">
            {{ formatDate(item.createdAt, intlLocale(locale)) }}
          </td>
          <td class="actions">
            <button
              v-if="item.orphaned"
              type="button"
              class="button"
              :aria-label="$t('shared.removeLabel', { name: item.name })"
              @click="remove(item)"
            >
              {{ $t('shared.remove') }}
            </button>
            <RouterLink
              v-else-if="item.type === 'directory'"
              class="button"
              :to="folderRoute(item.source, '/')"
              :aria-label="$t('shared.openLabel', { name: item.name })"
            >
              {{ $t('shared.open') }}
            </RouterLink>
            <template v-else>
              <button
                type="button"
                class="button"
                :aria-label="$t('shared.previewLabel', { name: item.name })"
                @click="openPreview(item)"
              >
                {{ $t('shared.preview') }}
              </button>
              <a
                class="button"
                :href="downloadHref(item.source, [{ path: '/', type: 'file' }])"
                :aria-label="$t('shared.downloadLabel', { name: item.name })"
                download
              >
                {{ $t('shared.download') }}
              </a>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
    <PreviewDialog
      v-if="preview"
      :files="[preview.entry]"
      :start="0"
      :source="preview.source"
      @close="preview = null"
    />
  </section>
</template>
