<script setup lang="ts">
// Shares one item of the member's own source with other members (#146): a member picker (WAI-ARIA combobox, filtered
// by name, focus stays in the field, the active option is aria-activedescendant), the access level as two radios,
// "Share", and the list of who has access with "Remove access" per member. Esc in the open picker list closes only
// the list; otherwise it closes the dialog. Public links of the item are managed below (LinkManager, #147).
// "Share" sits at the right end of the access row (#238), so the forward action is right-aligned and Tab still runs
// member, access, Share.
// The list overlays the form, so closing it on focusout never moves the control being clicked (#223). Focus opens it
// with every member (a shard has few), and a name typed in full that only one member matches picks that member.
import { computed, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Access, CreateShareRequest, Entry, Member, MemberList, PublicLink, Share, ShareList } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { isActiveLink } from '../activeLink.ts';
import { memberName } from '../memberName.ts';
import AppDialog from './AppDialog.vue';
import LinkManager from './LinkManager.vue';

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
// Not tied to `open`: the note stays when the field loses the focus, until the name changes.
const noMatch = computed(() => !chosen.value && text.value.trim() !== '' && matches.value.length === 0 && (members.value?.length ?? 0) > 0);

const fail = (e: unknown) => {
  if (!(e instanceof ApiFailure)) throw e;
  error.value = t(`errors.${e.code}`);
};
// "Only you." only without members and without a public link that still opens the item (#407), as in the drawer.
const hasActiveLink = ref(false);
const onLinks = (links: PublicLink[]) => {
  const now = Date.now();
  hasActiveLink.value = links.some((l) => isActiveLink(l, now));
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
  const [only, ...more] = matches.value;
  if (only && more.length === 0 && only.displayName.toLocaleLowerCase() === text.value.trim().toLocaleLowerCase()) pick(only);
}
function pick(m: Member) {
  chosen.value = m; text.value = memberName(m);
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
    status.value = t('share.shared', { name: memberName(s.grantee), access: t(`share.${s.access}`) });
    text.value = ''; chosen.value = null; access.value = 'read';
  } catch (e) { fail(e); } finally { busy.value = false; }
}
async function revoke(s: Share) {
  error.value = ''; status.value = '';
  try {
    await api.delete(`/api/v1/shares/${encodeURIComponent(s.id)}`);
    await loadShares();
    status.value = t('share.removed', { name: memberName(s.grantee) });
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
      <div class="app-dialog-field share-picker">
        <label
          class="fs-label"
          :for="pickerId"
        >{{ t('share.member') }}</label>
        <div class="share-field">
          <div
            ref="root"
            class="share-combo"
            @focusout="onFocusOut"
          >
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
              @focus="open = !chosen"
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
                {{ memberName(m) }}
              </li>
            </ul>
          </div>
        </div>
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
      <div class="share-send">
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
      </div>
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
      class="fs-section-heading"
    >
      {{ t('share.whoHasAccess') }}
    </h3>
    <ul
      v-if="shares.length"
      class="fs-entry-list"
      :aria-labelledby="whoId"
    >
      <li
        v-for="s in shares"
        :key="s.id"
      >
        <span class="share-name">{{ memberName(s.grantee) }}</span>
        <span class="share-level fs-pill">{{ t(`share.${s.access}`) }}</span>
        <button
          type="button"
          class="button danger"
          :aria-label="t('share.removeLabel', { name: memberName(s.grantee) })"
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
      {{ hasActiveLink ? t('share.linksOnly') : t('share.onlyYou') }}
    </p>
    <LinkManager
      :source="source"
      :entry="entry"
      @loaded="onLinks"
    />
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
