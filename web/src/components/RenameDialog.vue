<script setup lang="ts">
// Asks for a new name. The stem is preselected so typing keeps the extension. Esc or "Cancel" changes nothing. The parent
// renames; a refusal from the server comes back as `error` and keeps the dialog open with the typed name (#230), and
// `busy` holds the submit button while the request is in flight.
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { hasUnsafeChar, suggestName, type NameRuleSet } from '@files/shared';
import AppDialog from './AppDialog.vue';
import { nameRefusal } from '../nameRules.ts';

// `rules` and `dir`: the source's name rules (#342) and the folder the name goes into; a name they refuse is refused as
// it is typed, with the reason and the suggestion to take over.
const props = withDefaults(defineProps<{ name: string; isFolder: boolean; error?: string | null; busy?: boolean;
  rules?: NameRuleSet; dir?: string }>(), { error: null, busy: false, rules: 'universal', dir: '/' });
const emit = defineEmits<{ submit: [string]; cancel: [] }>();
const { t } = useI18n();
const value = ref(props.name);
const invalid = ref<'invalid' | 'tooLong' | null>(null);
const input = ref<HTMLInputElement>();
const formId = useId();
const errorId = useId();
const refused = ref<string | null>(null);
const ruleRefusal = computed(() => (value.value.trim() === '' ? null : nameRefusal(t, props.rules, value.value.trim(), props.dir)));
const suggestion = computed(() => (ruleRefusal.value === null ? null : suggestName(props.rules, value.value.trim(), props.dir).name));
const message = computed(() => invalid.value ? t(`rename.${invalid.value}`) : ruleRefusal.value ?? refused.value);
function useSuggestion() {
  value.value = suggestion.value!;
  input.value?.focus();
}
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
  invalid.value = name === '' || name === '.' || name === '..' || name.includes('/') || hasUnsafeChar(name) ? 'invalid'
    : new TextEncoder().encode(name).length > MAX_NAME_BYTES ? 'tooLong' : null;
  if (invalid.value || ruleRefusal.value !== null) { input.value?.focus(); return; }
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
