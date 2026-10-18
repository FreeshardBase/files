<script setup lang="ts">
// "Shared with me" (#146): what other members shared with the member, newest first. A folder opens as the source
// `share:<id>`, a file downloads or opens in the preview overlay (#208). A share whose item the owner deleted says so
// and can be removed from the list.
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Entry, IncomingShare } from '@files/shared';
import { useSharedStore } from '../stores/shared.ts';
import { api, ApiFailure } from '../api/client.ts';
import { downloadHref, folderRoute, sourceApi } from '../api/paths.ts';
import PreviewDialog from '../components/PreviewDialog.vue';
import NameText from '../components/NameText.vue';
import RowSkeleton from '../components/RowSkeleton.vue';
import { formatDate, intlLocale } from '../format.ts';
import { memberName } from '../memberName.ts';
import { useRouter } from 'vue-router';
import { acceptDrag, drag, droppedPaths, pendingDrop, refuseDrag, springLeave, springOver } from '../dnd.ts';

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

// Dragged items (#338): a shared folder held under them opens; one with edit access takes them into its root, one
// with read access refuses them.
const router = useRouter();
const dropOver = ref<string | null>(null);
watch(() => drag.items, (i) => { if (!i) dropOver.value = null; }); // ended or cancelled without a leave
const isFolder = (item: IncomingShare) => item.type === 'directory' && !item.orphaned;
function onDragOver(e: DragEvent, item: IncomingShare) {
  if (!isFolder(item)) { refuseDrag(e); return; }
  springOver(e, `share:${item.id}`, () => { void router.push(folderRoute(item.source, '/')); });
  if (item.access === 'edit' ? acceptDrag(e, item.source, item.name) : refuseDrag(e)) dropOver.value = item.access === 'edit' ? item.id : null;
}
function onDragLeave(e: DragEvent, item: IncomingShare) {
  springLeave(e, `share:${item.id}`);
  if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) return;
  if (dropOver.value === item.id) dropOver.value = null;
}
function onDrop(e: DragEvent, item: IncomingShare) {
  dropOver.value = null;
  if (!isFolder(item) || item.access !== 'edit') return;
  const items = droppedPaths(e, item.source);
  if (!items) return;
  pendingDrop.value = { source: items.source, paths: items.paths, mode: items.mode, to: item.source, dir: '/' };
  void router.push(folderRoute(item.source, '/'));
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
          :class="{ 'drop-target': dropOver === item.id }"
          @dragenter="onDragOver($event, item)"
          @dragover="onDragOver($event, item)"
          @dragleave="onDragLeave($event, item)"
          @drop="onDrop($event, item)"
        >
          <td class="name">
            <div class="name-inner">
              <span
                class="icon"
                :class="item.type === 'directory' ? 'icon-folder' : 'icon-file'"
                aria-hidden="true"
              />
              <NameText :name="item.name" />
            </div>
          </td>
          <td class="origin">
            {{ memberName(item.owner) }}
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
