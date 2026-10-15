<script setup lang="ts">
// Asks for a new name. The stem is preselected so typing keeps the extension. Esc or "Cancel" changes nothing.
import { nextTick, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import AppDialog from './AppDialog.vue';

const props = defineProps<{ name: string; isFolder: boolean }>();
const emit = defineEmits<{ submit: [string]; cancel: [] }>();
const { t } = useI18n();
const value = ref(props.name);
const invalid = ref(false);
const input = ref<HTMLInputElement>();
const formId = useId();
const errorId = useId();

onMounted(async () => {
  await nextTick(); // after AppDialog has focused the field
  const dot = props.name.lastIndexOf('.');
  input.value?.setSelectionRange(0, !props.isFolder && dot > 0 ? dot : props.name.length);
});
function submit() {
  const name = value.value.trim();
  // The server checks names too; this only saves a round trip for the obvious cases.
  invalid.value = name === '' || name === '.' || name === '..' || name.includes('/');
  if (invalid.value) { input.value?.focus(); return; }
  emit('submit', name);
}
</script>

<template>
  <AppDialog
    :title="t('rename.title')"
    @close="emit('cancel')"
  >
    <form
      :id="formId"
      class="app-dialog-form"
      @submit.prevent="submit"
    >
      <label class="app-dialog-field">
        <span class="fs-label">{{ t('rename.label') }}</span>
        <input
          ref="input"
          v-model="value"
          class="fs-input"
          type="text"
          data-autofocus
          autocomplete="off"
          spellcheck="false"
          :aria-invalid="invalid"
          :aria-describedby="invalid ? errorId : undefined"
        >
      </label>
      <p
        v-if="invalid"
        :id="errorId"
        class="fs-field__error"
      >
        {{ t('rename.invalid') }}
      </p>
    </form>
    <template #actions>
      <button
        type="button"
        class="button"
        @click="emit('cancel')"
      >
        {{ t('rename.cancel') }}
      </button>
      <button
        type="submit"
        class="button primary"
        :form="formId"
      >
        {{ t('rename.submit') }}
      </button>
    </template>
  </AppDialog>
</template>
