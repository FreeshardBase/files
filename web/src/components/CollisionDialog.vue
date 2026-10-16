<script setup lang="ts">
// Asks what to do with one item whose name is taken. Shared by upload, move, copy and restore.
// Esc counts as "skip" for this item only: closing must never overwrite or decide for the rest.
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import AppDialog from './AppDialog.vue';

export type CollisionChoice = { policy: 'replace' | 'keep-both' | 'skip'; all: boolean };
defineProps<{ name: string; remaining: number; returnFocus?: HTMLElement | null }>();
const emit = defineEmits<{ choose: [CollisionChoice] }>();
const { t } = useI18n();
const all = ref(false);
const choose = (policy: CollisionChoice['policy']) => emit('choose', { policy, all: all.value });
</script>

<template>
  <AppDialog
    :title="t('collision.title')"
    :return-focus="returnFocus"
    @close="emit('choose', { policy: 'skip', all: false })"
  >
    <p class="app-dialog-text">
      {{ t('collision.message', { name }) }}
    </p>
    <label
      v-if="remaining > 0"
      class="app-dialog-check"
    >
      <input
        v-model="all"
        type="checkbox"
      >
      {{ t('collision.applyAll', { count: remaining }) }}
    </label>
    <!-- The forward action last, on the right, as in every dialog (#238). -->
    <template #actions>
      <button
        type="button"
        class="button"
        @click="choose('skip')"
      >
        {{ t('collision.skip') }}
      </button>
      <button
        type="button"
        class="button danger"
        @click="choose('replace')"
      >
        {{ t('collision.replace') }}
      </button>
      <button
        type="button"
        class="button primary"
        data-autofocus
        @click="choose('keep-both')"
      >
        {{ t('collision.keepBoth') }}
      </button>
    </template>
  </AppDialog>
</template>
