<script setup lang="ts">
import { ref } from 'vue';
const emit = defineEmits<{ files: [File[]] }>();
const input = ref<HTMLInputElement>();
function picked() {
  const files = Array.from(input.value?.files ?? []);
  if (files.length) emit('files', files);
  if (input.value) input.value.value = '';
}
</script>
<template>
  <label class="button primary upload">
    {{ $t('upload.button') }}
    <input
      ref="input"
      type="file"
      multiple
      class="visually-hidden"
      data-testid="upload-input"
      @change="picked"
    >
  </label>
</template>
