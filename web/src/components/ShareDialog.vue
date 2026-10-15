<script setup lang="ts">
// Shares one item of the member's own source with other members (#146): a member picker (WAI-ARIA combobox, filtered
// by name, focus stays in the field, the active option is aria-activedescendant), the access level as two radios,
// "Share", and the list of who has access with "Remove access" per member. Esc in the open picker list closes only
// the list; otherwise it closes the dialog.
import { computed, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Access, CreateShareRequest, Entry, Member, MemberList, Share, ShareList } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import AppDialog from './AppDialog.vue';

const props = defineProps<{ source: string; entry: Entry; returnFocus?: HTMLElement | null }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const members = ref<Member[] | null>(null);
const shares = ref<Share[]>([]);
const text = ref('');
const chosen = ref<Member | null>(null);
const access = ref<Access>('read');
const open = ref(false);
const active = ref(-1);
const busy = ref(false);
const error = ref('');
const status = ref('');
const listId = useId(); const pickerId = useId(); const errorId = useId(); const whoId = useId();
const optionId = (i: number) => `${listId}-option-${i}`;

const matches = computed(() => {
  const q = text.value.trim().toLocaleLowerCase();
  return (members.value ?? []).filter((m) => m.displayName.toLocaleLowerCase().includes(q));
});
const showList = computed(() => open.value && matches.value.length > 0);
const noMatch = computed(() => open.value && text.value.trim() !== '' && matches.value.length === 0 && (members.value?.length ?? 0) > 0);

const fail = (e: unknown) => {
  if (!(e instanceof ApiFailure)) throw e;
  error.value = t(`errors.${e.code}`);
};
async function loadShares() {
  shares.value = (await api.get<ShareList>('/api/v1/shares', { source: props.source, path: props.entry.path })).items;
}
onMounted(async () => {
  try {
    members.value = (await api.get<MemberList>('/api/v1/members')).items;
    await loadShares();
  } catch (e) { fail(e); }
});

function onInput() {
  chosen.value = null; error.value = '';
  open.value = true; active.value = -1;
}
function pick(m: Member) {
  chosen.value = m; text.value = m.displayName;
  open.value = false; active.value = -1; error.value = '';
}
function move(by: number) {
  if (!open.value) { open.value = true; active.value = -1; }
  const n = matches.value.length;
  if (n === 0) return;
  active.value = active.value < 0 ? (by > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, active.value + by));
  document.getElementById(optionId(active.value))?.scrollIntoView({ block: 'nearest' });
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter') {
    // The active option, else the first one, picks; with nothing to pick, Enter shares like the button.
    const m = matches.value[active.value] ?? (open.value && text.value.trim() ? matches.value[0] : undefined);
    e.preventDefault();
    if (m) pick(m); else void submit();
  } else if (e.key === 'Escape' && showList.value) {
    e.preventDefault(); e.stopPropagation(); // the dialog stays open
    open.value = false; active.value = -1;
  }
}
const root = ref<HTMLElement>();
const picker = ref<HTMLInputElement>();
function onFocusOut(e: FocusEvent) {
  if (!root.value?.contains(e.relatedTarget as Node | null)) { open.value = false; active.value = -1; }
}

async function submit() {
  // A name typed in full counts as picked, so the keyboard path does not depend on the list.
  const m = chosen.value ?? (members.value ?? []).find((x) => x.displayName.toLocaleLowerCase() === text.value.trim().toLocaleLowerCase());
  if (!m) { error.value = t('share.pickMember'); return; }
  if (busy.value) return; // not `disabled`: that would drop the focus out of the dialog
  busy.value = true; error.value = ''; status.value = '';
  try {
    const body: CreateShareRequest = { source: props.source, path: props.entry.path, grantee: m.id, access: access.value };
    const s = await api.post<Share>('/api/v1/shares', body);
    await loadShares();
    status.value = t('share.shared', { name: s.grantee.displayName, access: t(`share.${s.access}`) });
    text.value = ''; chosen.value = null; access.value = 'read';
  } catch (e) { fail(e); } finally { busy.value = false; }
}
async function revoke(s: Share) {
  error.value = ''; status.value = '';
  try {
    await api.delete(`/api/v1/shares/${encodeURIComponent(s.id)}`);
    await loadShares();
    status.value = t('share.removed', { name: s.grantee.displayName });
    picker.value?.focus(); // the focused button is gone with its row; the member field is where sharing starts again
  } catch (e) { fail(e); }
}
</script>

<template>
  <AppDialog
    :title="t('share.title', { name: entry.name })"
    :return-focus="returnFocus"
    @close="emit('close')"
  >
    <form
      class="app-dialog-form share-form"
      @submit.prevent="submit"
    >
      <div
        ref="root"
        class="app-dialog-field share-picker"
        @focusout="onFocusOut"
      >
        <label
          class="fs-label"
          :for="pickerId"
        >{{ t('share.member') }}</label>
        <input
          :id="pickerId"
          ref="picker"
          v-model="text"
          class="fs-input"
          type="text"
          role="combobox"
          aria-autocomplete="list"
          :aria-controls="listId"
          :aria-expanded="showList"
          :aria-activedescendant="showList && active >= 0 ? optionId(active) : undefined"
          :aria-invalid="error !== ''"
          :aria-describedby="error ? errorId : undefined"
          :placeholder="t('share.memberPlaceholder')"
          autocomplete="off"
          spellcheck="false"
          data-autofocus
          @input="onInput"
          @keydown="onKey"
          @focus="open = text.trim() !== '' && !chosen"
        >
        <ul
          v-show="showList"
          :id="listId"
          role="listbox"
          class="share-options"
          :aria-label="t('share.options')"
        >
          <li
            v-for="(m, i) in matches"
            :id="optionId(i)"
            :key="m.id"
            role="option"
            class="share-option"
            :aria-selected="i === active"
            @mousedown.prevent
            @click="pick(m)"
          >
            {{ m.displayName }}
          </li>
        </ul>
        <p
          v-if="noMatch"
          class="share-note"
        >
          {{ t('share.noMatch', { query: text.trim() }) }}
        </p>
        <p
          v-if="members && members.length === 0"
          class="share-note"
        >
          {{ t('share.noMembers') }}
        </p>
      </div>
      <fieldset class="share-access">
        <legend class="fs-label">
          {{ t('share.access') }}
        </legend>
        <label
          v-for="a in (['read', 'edit'] as const)"
          :key="a"
          class="share-radio"
        >
          <input
            v-model="access"
            type="radio"
            name="share-access"
            :value="a"
          >
          {{ t(`share.${a}`) }}
        </label>
      </fieldset>
      <button
        type="submit"
        class="button primary share-submit"
        :aria-disabled="busy"
      >
        {{ t('share.submit') }}
      </button>
      <p
        v-if="error"
        :id="errorId"
        class="fs-field__error"
        role="alert"
      >
        {{ error }}
      </p>
    </form>
    <h3
      :id="whoId"
      class="share-heading"
    >
      {{ t('share.whoHasAccess') }}
    </h3>
    <ul
      v-if="shares.length"
      class="share-list"
      :aria-labelledby="whoId"
    >
      <li
        v-for="s in shares"
        :key="s.id"
      >
        <span class="share-name">{{ s.grantee.displayName }}</span>
        <span class="share-level">{{ t(`share.${s.access}`) }}</span>
        <button
          type="button"
          class="button danger"
          :aria-label="t('share.removeLabel', { name: s.grantee.displayName })"
          @click="revoke(s)"
        >
          {{ t('share.remove') }}
        </button>
      </li>
    </ul>
    <p
      v-else
      class="share-note"
    >
      {{ t('share.onlyYou') }}
    </p>
    <p
      class="visually-hidden"
      aria-live="polite"
    >
      {{ status }}
    </p>
    <template #actions>
      <button
        type="button"
        class="button"
        @click="emit('close')"
      >
        {{ t('share.close') }}
      </button>
    </template>
  </AppDialog>
</template>
