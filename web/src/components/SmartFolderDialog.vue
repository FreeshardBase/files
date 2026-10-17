<script setup lang="ts">
// Creating or editing a smart folder (#214): its name, then the query as structured fields: part of the name, the kinds
// of item, a tag, changed within N days, a size range in MB and the places to ask (all of them unless some are left
// out). No field takes a query language. The dialog saves through the store; a refusal stays in the dialog.
import { computed, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { MAX_TAG_LENGTH, SMART_TYPES, type SmartFolder, type SmartQuery, type SmartType } from '@files/shared';
import AppDialog from './AppDialog.vue';
import { ApiFailure } from '../api/client.ts';
import { useConnectionsStore } from '../stores/connections.ts';
import { useSmartFoldersStore } from '../stores/smartFolders.ts';
import { useTagsStore } from '../stores/tags.ts';
import { useLocations } from '../location.ts';

// `editing`: the smart folder to change; otherwise a new one, with `initial` filled in (the search's text).
const props = defineProps<{ editing?: SmartFolder; initial?: { name?: string; query?: SmartQuery } }>();
const emit = defineEmits<{ saved: [SmartFolder]; cancel: [] }>();
const { t } = useI18n();
const store = useSmartFoldersStore();
const connections = useConnectionsStore();
const tagStore = useTagsStore();
const { sourceName, sourceAccount } = useLocations();
onMounted(() => { void tagStore.loadAll(); });

const MB = 1_000_000; // sizes are shown in decimal units everywhere (format.ts)
const start = props.editing ?? props.initial ?? {};
const q: SmartQuery = start.query ?? {};
const name = ref(start.name ?? '');
const contains = ref(q.name ?? '');
const types = ref<SmartType[]>([...(q.types ?? [])]);
const tag = ref(q.tag ?? '');
const days = ref<number | ''>(q.modifiedWithinDays ?? '');
const sizeMin = ref<number | ''>(q.sizeMin !== undefined ? q.sizeMin / MB : '');
const sizeMax = ref<number | ''>(q.sizeMax !== undefined ? q.sizeMax / MB : '');
const allSources = computed(() => ['home', ...connections.items.map((c) => c.source)]);
const sources = ref<string[]>([...(q.sources ?? allSources.value)]);
const busy = ref(false);
const error = ref('');
const formId = useId();
const tagList = useId();
const label = (s: string) => (sourceAccount(s) ? `${sourceName(s)} (${sourceAccount(s)})` : sourceName(s));

const num = (v: number | '') => (v === '' || Number.isNaN(v) ? undefined : v);
function query(): SmartQuery | null {
  const min = num(sizeMin.value); const max = num(sizeMax.value);
  const criteria: SmartQuery = {
    ...(contains.value.trim() ? { name: contains.value.trim() } : {}),
    ...(types.value.length ? { types: SMART_TYPES.filter((x) => types.value.includes(x)) } : {}),
    ...(tag.value.trim() ? { tag: tag.value.trim() } : {}),
    ...(num(days.value) !== undefined ? { modifiedWithinDays: Math.round(num(days.value)!) } : {}),
    ...(min !== undefined ? { sizeMin: Math.round(min * MB) } : {}),
    ...(max !== undefined ? { sizeMax: Math.round(max * MB) } : {}),
  };
  if (Object.keys(criteria).length === 0) { error.value = t('smart.needsCriterion'); return null; }
  if (sources.value.length === 0) { error.value = t('smart.needsSource'); return null; }
  if (min !== undefined && max !== undefined && min > max) { error.value = t('smart.sizeRange'); return null; }
  // Every place ticked is "all of them", so a connection added later is asked too.
  const some = allSources.value.some((s) => !sources.value.includes(s));
  return some ? { ...criteria, sources: allSources.value.filter((s) => sources.value.includes(s)) } : criteria;
}

async function submit() {
  if (busy.value) return;
  error.value = '';
  const trimmed = name.value.trim();
  if (!trimmed) { error.value = t('smart.needsName'); return; }
  const body = query();
  if (!body) return;
  busy.value = true;
  try {
    const saved = props.editing ? await store.update(props.editing.id, { name: trimmed, query: body })
      : await store.create({ name: trimmed, query: body });
    emit('saved', saved);
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    error.value = t(`errors.${e.code}`, e.params ?? {});
  } finally { busy.value = false; }
}
</script>

<template>
  <AppDialog
    :title="editing ? t('smart.editTitle', { name: editing.name }) : t('smart.newTitle')"
    @close="emit('cancel')"
  >
    <form
      :id="formId"
      class="app-dialog-form smart-form"
      @submit.prevent="submit"
    >
      <label class="app-dialog-field">
        <span class="fs-label">{{ t('smart.name') }}</span>
        <input
          v-model="name"
          class="fs-input"
          type="text"
          maxlength="80"
          data-autofocus
          autocomplete="off"
        >
      </label>
      <label class="app-dialog-field">
        <span class="fs-label">{{ t('smart.contains') }}</span>
        <input
          v-model="contains"
          class="fs-input"
          type="text"
          maxlength="200"
          autocomplete="off"
          spellcheck="false"
        >
      </label>
      <fieldset class="migrate-accounts">
        <legend class="fs-label">
          {{ t('smart.types') }}
        </legend>
        <label
          v-for="ty in SMART_TYPES"
          :key="ty"
          class="migrate-radio"
        >
          <input
            v-model="types"
            type="checkbox"
            :value="ty"
          >
          {{ t(`smart.type.${ty}`) }}
        </label>
      </fieldset>
      <label class="app-dialog-field">
        <span class="fs-label">{{ t('smart.tag') }}</span>
        <input
          v-model="tag"
          class="fs-input"
          type="text"
          :list="tagList"
          :maxlength="MAX_TAG_LENGTH"
          autocomplete="off"
          spellcheck="false"
        >
      </label>
      <datalist :id="tagList">
        <option
          v-for="s in tagStore.all"
          :key="s.name"
          :value="s.name"
        />
      </datalist>
      <label class="app-dialog-field">
        <span class="fs-label">{{ t('smart.days') }}</span>
        <input
          v-model.number="days"
          class="fs-input"
          type="number"
          min="1"
          max="36500"
          step="1"
          inputmode="numeric"
        >
      </label>
      <div class="smart-size">
        <label class="app-dialog-field">
          <span class="fs-label">{{ t('smart.sizeMin') }}</span>
          <input
            v-model.number="sizeMin"
            class="fs-input"
            type="number"
            min="0"
            step="any"
            inputmode="decimal"
          >
        </label>
        <label class="app-dialog-field">
          <span class="fs-label">{{ t('smart.sizeMax') }}</span>
          <input
            v-model.number="sizeMax"
            class="fs-input"
            type="number"
            min="0"
            step="any"
            inputmode="decimal"
          >
        </label>
      </div>
      <fieldset
        v-if="allSources.length > 1"
        class="migrate-accounts"
      >
        <legend class="fs-label">
          {{ t('smart.sources') }}
        </legend>
        <label
          v-for="s in allSources"
          :key="s"
          class="migrate-radio"
        >
          <input
            v-model="sources"
            type="checkbox"
            :value="s"
          >
          {{ label(s) }}
        </label>
      </fieldset>
      <p
        v-if="error"
        class="fs-field__error"
        role="alert"
      >
        {{ error }}
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
        {{ t('smart.save') }}
      </button>
    </template>
  </AppDialog>
</template>
