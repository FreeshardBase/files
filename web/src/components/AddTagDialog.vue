<script setup lang="ts">
// "Add tag" for the selection (#212): one tag name, with the member's tags as suggestions. The parent adds it to every
// selected item (all or nothing); a refusal (too long, an item with 20 tags already) comes back as `error` and keeps the
// dialog open with the typed name.
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { MAX_TAG_LENGTH, normalizeTagName } from '@files/shared';
import AppDialog from './AppDialog.vue';
import { useTagsStore } from '../stores/tags.ts';

const props = defineProps<{ count: number; error?: string | null; busy?: boolean }>();
const emit = defineEmits<{ submit: [string]; cancel: [] }>();
const { t } = useI18n();
const store = useTagsStore();
const value = ref('');
const invalid = ref(false);
const refused = ref<string | null>(null);
const input = ref<HTMLInputElement>();
const formId = useId();
const errorId = useId();
const listId = useId();
const message = computed(() => invalid.value ? t('errors.TAG_INVALID', { max: MAX_TAG_LENGTH }) : refused.value);
onMounted(() => { void store.loadAll(); });

watch(() => props.error, async (e) => {
  refused.value = e ?? null;
  if (!e) return;
  await nextTick();
  input.value?.focus();
});
watch(value, () => { invalid.value = false; refused.value = null; });
function submit() {
  if (props.busy) return;
  const name = normalizeTagName(value.value);
  invalid.value = name === null;
  if (name === null) { input.value?.focus(); return; }
  emit('submit', name);
}
</script>

<template>
  <AppDialog
    :title="t('tags.addTitle', { count }, count)"
    @close="emit('cancel')"
  >
    <form
      :id="formId"
      class="app-dialog-form"
      @submit.prevent="submit"
    >
      <label class="app-dialog-field">
        <span class="fs-label">{{ t('tags.nameLabel') }}</span>
        <input
          ref="input"
          v-model="value"
          class="fs-input"
          type="text"
          data-autofocus
          :list="listId"
          :maxlength="MAX_TAG_LENGTH * 2"
          autocomplete="off"
          spellcheck="false"
          :aria-invalid="message !== null"
          :aria-describedby="message !== null ? errorId : undefined"
        >
      </label>
      <datalist :id="listId">
        <option
          v-for="s in store.all"
          :key="s.name"
          :value="s.name"
        />
      </datalist>
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
        {{ t('folder.cancel') }}
      </button>
      <button
        type="submit"
        class="button primary"
        :form="formId"
        :disabled="busy"
      >
        {{ t('tags.add') }}
      </button>
    </template>
  </AppDialog>
</template>
