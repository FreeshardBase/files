<script setup lang="ts">
// File picker and folder picker. A folder's files keep their path below it (`webkitRelativePath`), so the upload
// recreates the folder.
import { ref } from 'vue';
import type { PickedFile } from '../stores/uploads.ts';
const emit = defineEmits<{ files: [PickedFile[]] }>();
const input = ref<HTMLInputElement>();
const folderInput = ref<HTMLInputElement>();
function picked(el: HTMLInputElement | undefined) {
  const files = Array.from(el?.files ?? []).map((file) => ({ file, rel: file.webkitRelativePath || file.name }));
  if (files.length) emit('files', files);
  if (el) el.value = '';
}
// `input` is the focus target a dialog opened by an upload returns to; both pickers also open from the phone toolbar's
// Upload menu (#245), which stands in for these two buttons there.
defineExpose({ input, folderInput });
</script>
<template>
  <div class="upload-buttons">
    <label class="button primary upload">
      {{ $t('upload.button') }}
      <input
        ref="input"
        type="file"
        multiple
        class="visually-hidden"
        data-testid="upload-input"
        @change="picked(input)"
      >
    </label>
    <label class="button upload">
      {{ $t('upload.folderButton') }}
      <input
        ref="folderInput"
        type="file"
        webkitdirectory
        class="visually-hidden"
        data-testid="upload-folder-input"
        @change="picked(folderInput)"
      >
    </label>
  </div>
</template>
