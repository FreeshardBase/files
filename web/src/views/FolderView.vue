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
const status = ref('');
const path = computed(() => {
  const p = route.params.path; const segs = Array.isArray(p) ? p : p ? [p] : [];
  return '/' + segs.join('/');
});
watch(path, (p) => folder.open(p), { immediate: true });

const folderName = computed(() => path.value === '/' ? t('nav.home') : path.value.split('/').pop()!);
function open(e: Entry) {
  if (e.type === 'directory') router.push(e.path.split('/').map(encodeURIComponent).join('/'));
}
async function upload(files: File[]) {
  for (const f of files) {
    try {
      await folder.upload(f, 'fail', (x) => { status.value = t('upload.progress', { name: f.name, percent: Math.round(x * 100) }); });
      status.value = t('upload.done', { name: f.name });
    } catch (e) {
      if (!(e instanceof ApiFailure)) throw e;
      status.value = e.code === 'FILE_EXISTS' ? t('upload.exists', { name: f.name }) : t(`errors.${e.code}`);
    }
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
