<script setup lang="ts">
// Asks before something that cannot be undone. "Cancel" takes the initial focus, and Esc cancels too. Cancel sits
// left, the destructive action right, as in the guide's confirm dialog (#238).
import { useI18n } from 'vue-i18n';
import AppDialog from './AppDialog.vue';

defineProps<{ title: string; message: string; confirmLabel: string }>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const { t } = useI18n();
</script>

<template>
  <AppDialog
    :title="title"
    @close="emit('cancel')"
  >
    <p class="app-dialog-text">
      {{ message }}
    </p>
    <template #actions>
      <button
        type="button"
        class="button"
        data-autofocus
        @click="emit('cancel')"
      >
        {{ t('trash.cancel') }}
      </button>
      <button
        type="button"
        class="button danger"
        @click="emit('confirm')"
      >
        {{ confirmLabel }}
      </button>
    </template>
  </AppDialog>
</template>
