<script setup lang="ts">
// Asks for the name of a new folder (#221). The parent creates it; a refusal from the server (a taken name) comes back as
// `error` and keeps the dialog open with the field focused. Esc or "Cancel" creates nothing.
import { computed, nextTick, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { hasUnsafeChar, suggestName, type NameRuleSet } from '@files/shared';
import AppDialog from './AppDialog.vue';
import { nameRefusal } from '../nameRules.ts';

// `rules` and `dir`: as in RenameDialog (#342).
const props = withDefaults(defineProps<{ error?: string | null; busy?: boolean; rules?: NameRuleSet; dir?: string }>(),
  { error: null, busy: false, rules: 'universal', dir: '/' });
const emit = defineEmits<{ submit: [string]; cancel: [] }>();
const { t } = useI18n();
const value = ref('');
const invalid = ref(false);
const input = ref<HTMLInputElement>();
const formId = useId();
const errorId = useId();
const refused = ref<string | null>(null);
const ruleRefusal = computed(() => (value.value.trim() === '' ? null : nameRefusal(t, props.rules, value.value.trim(), props.dir)));
const suggestion = computed(() => (ruleRefusal.value === null ? null : suggestName(props.rules, value.value.trim(), props.dir).name));
const message = computed(() => invalid.value ? t('folder.invalid') : ruleRefusal.value ?? refused.value);
function useSuggestion() {
  value.value = suggestion.value!;
  input.value?.focus();
}

watch(() => props.error, async (e) => {
  refused.value = e ?? null;
  if (!e) return;
  await nextTick();
  input.value?.focus();
});
watch(value, () => { invalid.value = false; refused.value = null; }); // the message was about the name just changed
function submit() {
  if (props.busy) return;
  const name = value.value.trim();
  // The server checks names too; this only saves a round trip for the obvious cases.
  invalid.value = name === '' || name === '.' || name === '..' || name.includes('/') || hasUnsafeChar(name);
  if (invalid.value || ruleRefusal.value !== null) { input.value?.focus(); return; }
  emit('submit', name);
}
</script>

<template>
  <AppDialog
    :title="t('folder.newFolder')"
    @close="emit('cancel')"
  >
    <form
      :id="formId"
      class="app-dialog-form"
      @submit.prevent="submit"
    >
      <p>{{ t('folder.newFolderPrompt') }}</p>
      <label class="app-dialog-field">
        <span class="fs-label">{{ t('folder.newFolderLabel') }}</span>
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
      <button
        v-if="suggestion !== null"
        type="button"
        class="button name-rules-use"
        @click="useSuggestion"
      >
        {{ t('nameRules.useSuggestion', { name: suggestion }) }}
      </button>
    </form>
    <template #actions>
      <button
        type="button"
        class="button"
        @click="emit('cancel')"
      >
        {{ t('folder.cancel') }}
      </button>
      <button
        type="submit"
        class="button primary"
        :form="formId"
        :disabled="busy"
      >
        {{ t('folder.create') }}
      </button>
    </template>
  </AppDialog>
</template>
