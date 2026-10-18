<script setup lang="ts">
// Asks about one item whose name the target source does not allow (#342), before a copy, move or upload into it. It
// shows the suggestion with every replaced character highlighted and why, and lets the member edit the name (checked
// as they type), use the suggestions for all remaining items, or skip this one. Looks and behaves like the collision
// question: Esc counts as "skip" for this item only.
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { checkName, suggestName, type NameRuleSet } from '@files/shared';
import AppDialog from './AppDialog.vue';
import { issueText, nameRefusal } from '../nameRules.ts';

/** `name` null is "skip"; `all` uses the suggestion for every remaining item. */
export type NameChoice = { name: string | null; all: boolean };
const props = defineProps<{ name: string; rules: NameRuleSet; dir: string; remaining: number; returnFocus?: HTMLElement | null }>();
const emit = defineEmits<{ choose: [NameChoice] }>();
const { t } = useI18n();
const suggestion = suggestName(props.rules, props.name, props.dir);
const value = ref(suggestion.name);
const formId = useId();
const errorId = useId();
const reasons = checkName(props.rules, props.name, props.dir).map((i) => issueText(t, props.rules, i));
const marked = new Set(suggestion.replaced);
const chars = [...suggestion.name].map((c, i) => ({ c, mark: marked.has(i) }));
const typed = computed(() => value.value.trim());
const refusal = computed(() => (typed.value === '' || typed.value.includes('/') ? t('rename.invalid')
  : nameRefusal(t, props.rules, typed.value, props.dir)));
function submit() {
  if (refusal.value === null) emit('choose', { name: typed.value, all: false });
}
</script>

<template>
  <AppDialog
    :title="t('nameRules.title')"
    :return-focus="returnFocus"
    @close="emit('choose', { name: null, all: false })"
  >
    <p class="app-dialog-text">
      {{ t('nameRules.message', { name, provider: t(`nameRules.provider.${rules}`) }) }}
    </p>
    <ul class="name-rules-reasons">
      <li
        v-for="r in reasons"
        :key="r"
      >
        {{ r }}
      </li>
    </ul>
    <p class="name-rules-suggestion">
      <span class="fs-label">{{ t('nameRules.suggestion') }}</span>
      <span
        class="name-rules-preview"
        data-testid="name-suggestion"
      ><template
        v-for="(x, i) in chars"
        :key="i"
      ><mark
        v-if="x.mark"
        class="name-rules-mark"
      >{{ x.c }}</mark><template v-else>{{ x.c }}</template></template></span>
    </p>
    <form
      :id="formId"
      class="app-dialog-form"
      @submit.prevent="submit"
    >
      <label class="app-dialog-field">
        <span class="fs-label">{{ t('nameRules.label') }}</span>
        <input
          v-model="value"
          class="fs-input"
          type="text"
          data-autofocus
          autocomplete="off"
          spellcheck="false"
          :aria-invalid="refusal !== null"
          :aria-describedby="refusal !== null ? errorId : undefined"
        >
      </label>
      <p
        v-if="refusal !== null"
        :id="errorId"
        class="fs-field__error"
      >
        {{ refusal }}
      </p>
    </form>
    <template #actions>
      <button
        type="button"
        class="button collision-action"
        @click="emit('choose', { name: null, all: false })"
      >
        {{ t('nameRules.skip') }}
      </button>
      <button
        v-if="remaining > 0"
        type="button"
        class="button collision-action"
        @click="emit('choose', { name: suggestion.name, all: true })"
      >
        {{ t('nameRules.applyAll', { count: remaining }) }}
      </button>
      <button
        type="submit"
        class="button primary collision-action"
        :form="formId"
        :disabled="refusal !== null"
      >
        {{ t('nameRules.apply') }}
      </button>
    </template>
  </AppDialog>
</template>

<style scoped>
.name-rules-reasons { margin: 0; padding-left: 1.25rem; color: var(--ink-muted); }
.name-rules-suggestion { display: flex; flex-direction: column; gap: 0.25rem; margin: 0; }
.name-rules-preview { font-family: var(--font-mono); overflow-wrap: anywhere; }
/* A replaced character: the accent behind it and under it, so it reads without colour too. */
.name-rules-mark { background: color-mix(in srgb, var(--accent) 18%, transparent); color: inherit;
  border-bottom: 2px solid var(--accent); font-weight: 600; }
</style>
