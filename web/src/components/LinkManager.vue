<script setup lang="ts">
// Public links of one item (#147), inside the share dialog: the list (address, password, expiry, downloads; copy,
// edit, revoke) and one form for a new link or the one being edited (label, expiry, download limit, password).
// The server decides about the expiry: a value the browser cannot read is sent as typed and answered INVALID_EXPIRY.
import { nextTick, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CreateLinkRequest, Entry, PublicLink, PublicLinkList, UpdateLinkRequest } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { formatDate, intlLocale } from '../format.ts';

const props = defineProps<{ source: string; entry: Entry }>();
const { t, locale } = useI18n();
const links = ref<PublicLink[]>([]);
const editing = ref<PublicLink | 'new' | null>(null);
// Vue casts a `type="number"` field's value to a number once something is typed; empty stays ''.
const label = ref(''); const expiry = ref(''); const limit = ref<string | number>(''); const password = ref(''); const dropPassword = ref(false);
const error = ref(''); const status = ref(''); const busy = ref(false);
const headingId = useId(); const formId = useId(); const errorId = useId();
const firstField = ref<HTMLInputElement>(); const newButton = ref<HTMLButtonElement>();

const fail = (e: unknown) => { if (!(e instanceof ApiFailure)) throw e; error.value = t(`errors.${e.code}`); };
const load = async () => {
  links.value = (await api.get<PublicLinkList>('/api/v1/links', { source: props.source, path: props.entry.path })).items;
};
onMounted(async () => { try { await load(); } catch (e) { fail(e); } });

const nameOf = (l: PublicLink) => l.label || t('link.unnamed');
const address = (l: PublicLink) => `${location.origin}/s/${l.token}`;
const pad = (n: number) => String(n).padStart(2, '0');
// `datetime-local` wants the member's local time without an offset.
const localInput = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

async function open(l: PublicLink | 'new') {
  editing.value = l; error.value = ''; status.value = ''; password.value = ''; dropPassword.value = false;
  label.value = l === 'new' ? '' : l.label;
  expiry.value = l === 'new' || !l.expiresAt ? '' : localInput(l.expiresAt);
  limit.value = l === 'new' || l.maxDownloads === null ? '' : String(l.maxDownloads);
  await nextTick(); firstField.value?.focus();
}
async function close() { editing.value = null; error.value = ''; await nextTick(); newButton.value?.focus(); }

function fields() {
  const typed = expiry.value.trim();
  const ms = typed ? new Date(typed).getTime() : NaN;
  return {
    label: label.value.trim(),
    expiresAt: typed === '' ? null : Number.isFinite(ms) ? new Date(ms).toISOString() : typed,
    maxDownloads: String(limit.value).trim() === '' ? null : Number(limit.value),
  };
}
async function submit() {
  if (busy.value || editing.value === null) return; // not `disabled`: that would drop the focus out of the dialog
  busy.value = true; error.value = ''; status.value = '';
  try {
    if (editing.value === 'new') {
      const body: CreateLinkRequest = { source: props.source, path: props.entry.path, ...fields(),
        password: password.value === '' ? null : password.value };
      await api.post<PublicLink>('/api/v1/links', body);
      status.value = t('link.created');
    } else {
      const body: UpdateLinkRequest = { ...fields(),
        ...(dropPassword.value ? { password: null } : password.value !== '' ? { password: password.value } : {}) };
      await api.patch<PublicLink>(`/api/v1/links/${encodeURIComponent(editing.value.id)}`, body);
      status.value = t('link.saved');
    }
    await load();
    await close();
  } catch (e) { fail(e); } finally { busy.value = false; }
}
async function revoke(l: PublicLink) {
  error.value = ''; status.value = '';
  try {
    await api.delete(`/api/v1/links/${encodeURIComponent(l.id)}`);
    await load();
    status.value = t('link.revoked', { name: nameOf(l) });
    newButton.value?.focus(); // the focused button is gone with its row
  } catch (e) { fail(e); }
}
// The address fields by link id, so "Copy" can fall back to selecting the address.
const inputs = new Map<string, HTMLInputElement>();
const setInput = (id: string, el: unknown) => { if (el instanceof HTMLInputElement) inputs.set(id, el); else inputs.delete(id); };
async function copy(l: PublicLink) {
  const input = inputs.get(l.id);
  try {
    await navigator.clipboard.writeText(address(l));
    status.value = t('link.copied');
  } catch {
    // handled: no clipboard (plain http, permission): the address is selected for the member to copy themselves
    input?.focus(); input?.select();
    status.value = t('link.copyManually');
  }
}
const downloads = (l: PublicLink) => l.maxDownloads === null
  ? t('link.downloads', { count: l.downloads }, l.downloads)
  : t('link.downloadsOf', { count: l.downloads, max: l.maxDownloads });
</script>

<template>
  <section
    class="links"
    :aria-labelledby="headingId"
  >
    <h3
      :id="headingId"
      class="share-heading"
    >
      {{ t('link.heading') }}
    </h3>
    <ul
      v-if="links.length"
      class="share-list link-list"
      :aria-labelledby="headingId"
    >
      <li
        v-for="l in links"
        :key="l.id"
      >
        <span class="share-name">{{ nameOf(l) }}</span>
        <span class="share-level">
          <template v-if="l.orphaned">{{ t('link.orphaned') }}</template>
          <template v-else>
            {{ l.hasPassword ? t('link.withPassword') : t('link.noPassword') }} ·
            {{ l.expiresAt ? t('link.expires', { date: formatDate(l.expiresAt, intlLocale(locale)) }) : t('link.noExpiry') }} ·
            {{ downloads(l) }}
          </template>
        </span>
        <input
          v-if="!l.orphaned"
          :ref="(el) => setInput(l.id, el)"
          class="fs-input link-address"
          type="text"
          readonly
          :value="address(l)"
          :aria-label="t('link.address', { name: nameOf(l) })"
          @focus="($event.target as HTMLInputElement).select()"
        >
        <span class="link-buttons">
          <button
            v-if="!l.orphaned"
            type="button"
            class="button"
            :aria-label="t('link.copyLabel', { name: nameOf(l) })"
            @click="copy(l)"
          >
            {{ t('link.copy') }}
          </button>
          <button
            v-if="!l.orphaned"
            type="button"
            class="button"
            :aria-label="t('link.editLabel', { name: nameOf(l) })"
            @click="open(l)"
          >
            {{ t('link.edit') }}
          </button>
          <button
            type="button"
            class="button danger"
            :aria-label="t('link.revokeLabel', { name: nameOf(l) })"
            @click="revoke(l)"
          >
            {{ t('link.revoke') }}
          </button>
        </span>
      </li>
    </ul>
    <p
      v-else
      class="share-note"
    >
      {{ t('link.none') }}
    </p>
    <form
      v-if="editing"
      :id="formId"
      class="app-dialog-form link-form"
      :aria-label="editing === 'new' ? t('link.new') : t('link.editing', { name: nameOf(editing) })"
      @submit.prevent="submit"
      @keydown.esc.stop.prevent="close"
    >
      <div class="app-dialog-field">
        <label
          class="fs-label"
          :for="`${formId}-label`"
        >{{ t('link.label') }}</label>
        <input
          :id="`${formId}-label`"
          ref="firstField"
          v-model="label"
          class="fs-input"
          type="text"
          maxlength="100"
          :placeholder="t('link.labelHint')"
        >
      </div>
      <div class="app-dialog-field">
        <label
          class="fs-label"
          :for="`${formId}-expiry`"
        >{{ t('link.expiry') }}</label>
        <input
          :id="`${formId}-expiry`"
          v-model="expiry"
          class="fs-input"
          type="datetime-local"
          :aria-describedby="`${formId}-expiry-hint`"
        >
        <p
          :id="`${formId}-expiry-hint`"
          class="share-note"
        >
          {{ t('link.expiryHint') }}
        </p>
      </div>
      <div class="app-dialog-field">
        <label
          class="fs-label"
          :for="`${formId}-limit`"
        >{{ t('link.limit') }}</label>
        <input
          :id="`${formId}-limit`"
          v-model="limit"
          class="fs-input"
          type="number"
          min="0"
          step="1"
          inputmode="numeric"
          :aria-describedby="`${formId}-limit-hint`"
        >
        <p
          :id="`${formId}-limit-hint`"
          class="share-note"
        >
          {{ t('link.limitHint') }}
        </p>
      </div>
      <div class="app-dialog-field">
        <label
          class="fs-label"
          :for="`${formId}-password`"
        >{{ t('link.password') }}</label>
        <input
          :id="`${formId}-password`"
          v-model="password"
          class="fs-input"
          type="password"
          autocomplete="new-password"
          maxlength="256"
          :disabled="dropPassword"
          :aria-describedby="`${formId}-password-hint`"
        >
        <p
          :id="`${formId}-password-hint`"
          class="share-note"
        >
          {{ editing !== 'new' && editing.hasPassword ? t('link.passwordKeep') : t('link.passwordHint') }}
        </p>
        <label
          v-if="editing !== 'new' && editing.hasPassword"
          class="app-dialog-check"
        >
          <input
            v-model="dropPassword"
            type="checkbox"
          >
          {{ t('link.removePassword') }}
        </label>
      </div>
      <p
        v-if="error"
        :id="errorId"
        class="fs-field__error"
        role="alert"
      >
        {{ error }}
      </p>
      <div class="link-buttons">
        <button
          type="submit"
          class="button primary"
          :aria-disabled="busy"
        >
          {{ editing === 'new' ? t('link.create') : t('link.save') }}
        </button>
        <button
          type="button"
          class="button"
          @click="close"
        >
          {{ t('link.cancel') }}
        </button>
      </div>
    </form>
    <template v-else>
      <p
        v-if="error"
        class="fs-field__error"
        role="alert"
      >
        {{ error }}
      </p>
      <button
        ref="newButton"
        type="button"
        class="button"
        @click="open('new')"
      >
        {{ t('link.new') }}
      </button>
    </template>
    <p
      class="visually-hidden"
      aria-live="polite"
    >
      {{ status }}
    </p>
  </section>
</template>
