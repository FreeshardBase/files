<script setup lang="ts">
// Asks for a new name. The stem is preselected so typing keeps the extension. Esc or "Cancel" changes nothing. The parent
// renames; a refusal from the server comes back as `error` and keeps the dialog open with the typed name (#230), and
// `busy` holds the submit button while the request is in flight.
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import AppDialog from './AppDialog.vue';

const props = defineProps<{ name: string; isFolder: boolean; error?: string | null; busy?: boolean }>();
const emit = defineEmits<{ submit: [string]; cancel: [] }>();
const { t } = useI18n();
const value = ref(props.name);
const invalid = ref<'invalid' | 'tooLong' | null>(null);
const input = ref<HTMLInputElement>();
const formId = useId();
const errorId = useId();
const refused = ref<string | null>(null);
const message = computed(() => invalid.value ? t(`rename.${invalid.value}`) : refused.value);
// The server's limit (resolveInRoot): 255 bytes of UTF-8 per name.
const MAX_NAME_BYTES = 255;

onMounted(async () => {
  await nextTick(); // after AppDialog has focused the field
  const dot = props.name.lastIndexOf('.');
  input.value?.setSelectionRange(0, !props.isFolder && dot > 0 ? dot : props.name.length);
});
watch(() => props.error, async (e) => {
  refused.value = e ?? null;
  if (!e) return;
  await nextTick();
  input.value?.focus();
});
watch(value, () => { invalid.value = null; refused.value = null; }); // the message was about the name just changed
function submit() {
  if (props.busy) return;
  const name = value.value.trim();
  // The server checks names too; this only saves a round trip for the obvious cases.
  invalid.value = name === '' || name === '.' || name === '..' || name.includes('/') ? 'invalid'
    : new TextEncoder().encode(name).length > MAX_NAME_BYTES ? 'tooLong' : null;
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
          :aria-invalid="message !== null"
          :aria-describedby="message !== null ? errorId : undefined"
        >
      </label>
      <p
        v-if="message !== null"
        :id="errorId"
        class="fs-field__error"
      >
        {{ message }}
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
        :disabled="busy"
      >
        {{ t('rename.submit') }}
      </button>
    </template>
  </AppDialog>
</template>
