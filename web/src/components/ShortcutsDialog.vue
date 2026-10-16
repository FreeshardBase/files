<script setup lang="ts">
// The keyboard shortcuts (#160): opened by "?" outside a text field or by the header button. The list is what FileList,
// ItemMenu, the gallery, FolderView (Shift+N, #221) and AppDialog actually handle; nothing here is a shortcut of its own.
// Key names are translated too ("Strg", "Entf").
import { useI18n } from 'vue-i18n';
import AppDialog from './AppDialog.vue';

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const SHORTCUTS = ['arrows', 'galleryArrows', 'homeEnd', 'open', 'select', 'selectAll', 'rename', 'trash', 'cut', 'copy',
  'paste', 'newFolder', 'menu', 'close', 'history', 'help'] as const;
</script>

<template>
  <AppDialog
    :title="t('shortcuts.title')"
    @close="emit('close')"
  >
    <table class="shortcuts">
      <thead class="visually-hidden">
        <tr>
          <th scope="col">
            {{ t('shortcuts.key') }}
          </th>
          <th scope="col">
            {{ t('shortcuts.action') }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="id in SHORTCUTS"
          :key="id"
        >
          <td class="shortcut-keys">
            <kbd>{{ t(`shortcuts.keys.${id}`) }}</kbd>
          </td>
          <td>{{ t(`shortcuts.actions.${id}`) }}</td>
        </tr>
      </tbody>
    </table>
    <template #actions>
      <button
        type="button"
        class="button"
        data-autofocus
        @click="emit('close')"
      >
        {{ t('shortcuts.closeButton') }}
      </button>
    </template>
  </AppDialog>
</template>
