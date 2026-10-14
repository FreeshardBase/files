<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { Entry } from '@files/shared';
import { useFolderStore } from '../stores/folder.ts';
import { ApiFailure } from '../api/client.ts';
import FileList from '../components/FileList.vue';
import Breadcrumbs from '../components/Breadcrumbs.vue';
import UploadButton from '../components/UploadButton.vue';

const route = useRoute(); const router = useRouter(); const { t } = useI18n();
const folder = useFolderStore();
type Failure = { name: string; reason: string };
const status = ref('');
const path = computed(() => {
  const p = route.params.path; const segs = Array.isArray(p) ? p : p ? [p] : [];
  return '/' + segs.join('/');
});
const failures = ref<Failure[]>([]);
watch(path, (p) => { status.value = ''; failures.value = []; void folder.open(p); }, { immediate: true });

const folderName = computed(() => path.value === '/' ? t('nav.home') : path.value.split('/').pop()!);
function open(e: Entry) {
  if (e.type === 'directory') router.push(e.path.split('/').map(encodeURIComponent).join('/'));
}
async function upload(files: File[]) {
  const dir = folder.path; // captured: navigating away mid-batch must not redirect the remaining files
  failures.value = [];
  let done = 0;
  try {
    for (const f of files) {
      try {
        await folder.upload(f, dir, 'fail', (x) => { status.value = t('upload.progress', { name: f.name, percent: Math.round(x * 100) }); });
        done++;
      } catch (e) {
        if (!(e instanceof ApiFailure)) throw e;
        failures.value.push({ name: f.name, reason: t('upload.failedItem', { name: f.name, reason: t(`errors.${e.code}`) }) });
      }
    }
    status.value = t('upload.summary', { done, total: files.length });
  } finally {
    if (dir === folder.path) await folder.open(dir, { refresh: true }); // once per batch, list stays mounted
  }
}
</script>

<template>
  <section class="folder">
    <div class="toolbar">
      <Breadcrumbs :path="path" />
      <UploadButton @files="upload" />
    </div>
    <p
      class="status"
      role="status"
      aria-live="polite"
    >
      {{ status }}
    </p>
    <div
      v-if="failures.length"
      class="upload-failures"
    >
      <p>{{ $t('upload.failedHeading') }}</p>
      <ul>
        <li
          v-for="(f, i) in failures"
          :key="i"
        >
          {{ f.reason }}
        </li>
      </ul>
    </div>
    <p v-if="folder.loading">
      {{ $t('folder.loading') }}
    </p>
    <p
      v-else-if="folder.error"
      role="alert"
    >
      {{ $t(`errors.${folder.error.code}`) }}
    </p>
    <p v-else-if="folder.entries.length === 0">
      {{ $t('folder.empty') }}
    </p>
    <FileList
      v-else
      :entries="folder.entries"
      :folder-name="folderName"
      @open="open"
    />
  </section>
</template>
