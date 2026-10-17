<script setup lang="ts">
// Batch rename (#215) for the selection of one folder: find and replace (plain text), capitals, numbering with a
// pattern and a start, prefix and suffix, on the name without its extension unless asked. The preview table is the
// server's plan for exactly these inputs (`/api/v1/renames/preview`), so it is what the job will do; a flagged row
// (a name taken inside or outside the batch, or one that cannot be used) blocks "Rename" until a policy is picked for
// it. The parent starts the job; a refusal comes back as `error` and keeps the dialog open.
import { computed, onUnmounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ALLOWED_POLICIES, MAX_NAME_BYTES, RENAME_CASES, type Entry, type RenameCase, type RenameOps, type RenamePlan,
  type RenamePolicy, type RenameRequest, type RenameRow } from '@files/shared';
import AppDialog from './AppDialog.vue';
import { api, ApiFailure } from '../api/client.ts';

const props = defineProps<{ source: string; dir: string; entries: Entry[]; error?: string | null; busy?: boolean }>();
const emit = defineEmits<{ submit: [RenameRequest]; cancel: [] }>();
const { t } = useI18n();
const formId = useId();
const statusId = useId();

const find = ref(''); const replace = ref('');
const caseMode = ref<RenameCase>('keep');
const numbering = ref(false); const pattern = ref('{name} {n}'); const start = ref(1);
const prefix = ref(''); const suffix = ref('');
const extension = ref(false);
const policies = ref<Record<string, RenamePolicy>>({});

const ops = computed<RenameOps>(() => ({
  ...(find.value ? { find: find.value, replace: replace.value } : {}),
  ...(caseMode.value !== 'keep' ? { case: caseMode.value } : {}),
  ...(numbering.value ? { numbering: { pattern: pattern.value, start: start.value } } : {}),
  ...(prefix.value ? { prefix: prefix.value } : {}),
  ...(suffix.value ? { suffix: suffix.value } : {}),
  ...(extension.value ? { extension: true } : {}),
}));
const request = computed<RenameRequest>(() => ({ source: props.source, dir: props.dir, ops: ops.value,
  items: props.entries.map((e) => ({ path: e.path, ...(policies.value[e.path] ? { policy: policies.value[e.path] } : {}) })) }));

// The plan of the inputs it was asked for; a newer request wins, and nothing runs on an answer for older inputs.
const plan = ref<RenamePlan | null>(null);
const planFor = ref('');
const failure = ref<string | null>(null);
const asked = computed(() => JSON.stringify(request.value));
let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;
watch(asked, (body) => {
  clearTimeout(timer);
  timer = setTimeout(() => { void load(body); }, 200);
}, { immediate: true });
onUnmounted(() => clearTimeout(timer));
async function load(body: string) {
  const mine = ++seq;
  try {
    const p = await api.post<RenamePlan>('/api/v1/renames/preview', JSON.parse(body) as RenameRequest);
    if (mine !== seq) return;
    plan.value = p; planFor.value = body; failure.value = null;
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    if (mine !== seq) return;
    plan.value = null; planFor.value = body; failure.value = t(`errors.${e.code}`);
  }
}
const current = computed(() => plan.value !== null && planFor.value === asked.value);
const checking = computed(() => planFor.value !== asked.value);
const renames = computed(() => (current.value ? plan.value!.rows.filter((r) => r.action === 'rename').length : 0));
const canSubmit = computed(() => current.value && !plan.value!.blocked && renames.value > 0 && !props.busy);
const status = computed(() => {
  if (failure.value && !checking.value) return failure.value;
  if (!current.value) return t('batchRename.checking');
  if (plan.value!.blocked) return t('batchRename.blocked');
  return renames.value === 0 ? t('batchRename.nothing') : '';
});

const policyKey = (p: RenamePolicy) => (p === 'keep-both' ? 'keepBoth' : p);
function check(r: RenameRow): string {
  if (r.action === 'skip') return t('batchRename.skipped');
  if (r.conflict === 'invalid') return t(`batchRename.problem.${r.problem!}`);
  if (r.conflict) return t(`batchRename.conflict.${r.conflict}`);
  return r.action === 'unchanged' ? t('batchRename.unchanged') : t('batchRename.ready');
}
function choose(path: string, e: Event) {
  const v = (e.target as HTMLSelectElement).value as RenamePolicy | '';
  const next = { ...policies.value };
  if (v) next[path] = v; else delete next[path];
  policies.value = next;
}
function submit() {
  if (canSubmit.value) emit('submit', request.value);
}
</script>

<template>
  <AppDialog
    :title="t('batchRename.title', { count: entries.length }, entries.length)"
    wide
    @close="emit('cancel')"
  >
    <form
      :id="formId"
      class="app-dialog-form batch-rename"
      @submit.prevent="submit"
    >
      <div class="batch-rename-fields">
        <label class="app-dialog-field">
          <span class="fs-label">{{ t('batchRename.find') }}</span>
          <input
            v-model="find"
            class="fs-input"
            type="text"
            data-autofocus
            :maxlength="MAX_NAME_BYTES"
            autocomplete="off"
            spellcheck="false"
          >
        </label>
        <label class="app-dialog-field">
          <span class="fs-label">{{ t('batchRename.replace') }}</span>
          <input
            v-model="replace"
            class="fs-input"
            type="text"
            :maxlength="MAX_NAME_BYTES"
            autocomplete="off"
            spellcheck="false"
          >
        </label>
        <label class="app-dialog-field">
          <span class="fs-label">{{ t('batchRename.prefix') }}</span>
          <input
            v-model="prefix"
            class="fs-input"
            type="text"
            :maxlength="MAX_NAME_BYTES"
            autocomplete="off"
            spellcheck="false"
          >
        </label>
        <label class="app-dialog-field">
          <span class="fs-label">{{ t('batchRename.suffix') }}</span>
          <input
            v-model="suffix"
            class="fs-input"
            type="text"
            :maxlength="MAX_NAME_BYTES"
            autocomplete="off"
            spellcheck="false"
          >
        </label>
        <label class="app-dialog-field">
          <span class="fs-label">{{ t('batchRename.case') }}</span>
          <select
            v-model="caseMode"
            class="fs-input"
          >
            <option
              v-for="c in RENAME_CASES"
              :key="c"
              :value="c"
            >
              {{ t(`batchRename.cases.${c}`) }}
            </option>
          </select>
        </label>
      </div>
      <label class="app-dialog-check">
        <input
          v-model="numbering"
          type="checkbox"
        >
        {{ t('batchRename.numbering') }}
      </label>
      <div
        v-if="numbering"
        class="batch-rename-fields"
      >
        <label class="app-dialog-field">
          <span class="fs-label">{{ t('batchRename.pattern') }}</span>
          <input
            v-model="pattern"
            class="fs-input"
            type="text"
            :maxlength="MAX_NAME_BYTES"
            autocomplete="off"
            spellcheck="false"
          >
          <span class="fs-field__hint">{{ t('batchRename.patternHint', { n: '{n}', padded: '{n:03}', name: '{name}' }) }}</span>
        </label>
        <label class="app-dialog-field">
          <span class="fs-label">{{ t('batchRename.start') }}</span>
          <input
            v-model.number="start"
            class="fs-input"
            type="number"
            min="0"
            step="1"
            inputmode="numeric"
          >
        </label>
      </div>
      <label class="app-dialog-check">
        <input
          v-model="extension"
          type="checkbox"
        >
        {{ t('batchRename.extension') }}
      </label>
      <div class="batch-rename-preview">
        <table
          class="file-list batch-rename-table"
          :aria-label="t('batchRename.preview')"
          :aria-busy="checking"
        >
          <thead>
            <tr>
              <th scope="col">
                {{ t('batchRename.old') }}
              </th>
              <th scope="col">
                {{ t('batchRename.new') }}
              </th>
              <th scope="col">
                {{ t('batchRename.check') }}
              </th>
            </tr>
          </thead>
          <tbody v-if="plan">
            <tr
              v-for="r in plan.rows"
              :key="r.path"
              :data-conflict="r.conflict && !r.policy ? r.conflict : undefined"
            >
              <td class="name">
                {{ r.name }}
              </td>
              <td class="name batch-rename-new">
                {{ r.to }}
              </td>
              <td class="batch-rename-check">
                <span :class="{ 'batch-rename-flag': r.conflict && !r.policy }">{{ check(r) }}</span>
                <select
                  v-if="r.conflict"
                  class="fs-input"
                  :aria-label="t('batchRename.policyLabel', { name: r.name })"
                  :value="policies[r.path] ?? ''"
                  @change="choose(r.path, $event)"
                >
                  <option value="">
                    {{ t('batchRename.policy.choose') }}
                  </option>
                  <option
                    v-for="p in ALLOWED_POLICIES[r.conflict]"
                    :key="p"
                    :value="p"
                  >
                    {{ t(`batchRename.policy.${policyKey(p)}`) }}
                  </option>
                </select>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p
        :id="statusId"
        class="batch-rename-status"
        role="status"
      >
        {{ status }}
      </p>
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
        {{ t('batchRename.cancel') }}
      </button>
      <button
        type="submit"
        class="button primary"
        :form="formId"
        :disabled="!canSubmit"
        :aria-describedby="statusId"
      >
        {{ t('batchRename.submit', { count: renames }, renames) }}
      </button>
    </template>
  </AppDialog>
</template>
