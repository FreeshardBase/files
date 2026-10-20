<script setup lang="ts">
// The member's file requests (#217): each with its address, its folder, how many files came in and how many of them are
// new (the badge) and how many visitors' uploads are unfinished, and copy, files, edit, discard the unfinished and revoke. One dialog creates or edits a request (folder, title, expiry,
// limits, password, the uploader name field); another lists the files a request received, which marks them seen, each a
// link to the request's folder with it selected (#311).
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { MAX_REQUEST_FILES, MAX_REQUEST_FILES_PER_VISITOR, type CreateFileRequest, type FileRequest, type ReceivedFile,
  type ReceivedFileList, type UpdateFileRequest } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { folderRoute } from '../api/paths.ts';
import { formatDate, formatSize, intlLocale } from '../format.ts';
import { useLocations } from '../location.ts';
import { useConnectionsStore } from '../stores/connections.ts';
import { useRequestsStore } from '../stores/requests.ts';
import AppDialog from '../components/AppDialog.vue';
import FolderPicker from '../components/FolderPicker.vue';

const { t, locale } = useI18n();
const requests = useRequestsStore();
const connections = useConnectionsStore();
const { folderLabel, sourceName } = useLocations();
const MB = 1_000_000; // sizes are decimal throughout the app (format.ts)

const status = ref(''); const error = ref('');
const fail = (e: unknown, into = error) => { if (!(e instanceof ApiFailure)) throw e; into.value = t(`errors.${e.code}`); };
onMounted(async () => { await requests.load(); if (requests.error) fail(requests.error); });

const nameOf = (r: FileRequest) => r.label || t('requests.unnamed');
const address = (r: FileRequest) => `${location.origin}/r/${r.token}`;
const expired = (r: FileRequest) => r.expiresAt !== null && Date.parse(r.expiresAt) <= Date.now();
const fmtDate = (iso: string) => formatDate(iso, intlLocale(locale.value));
const fmtSize = (n: number) => formatSize(n, intlLocale(locale.value));
const fmtCount = (n: number) => n.toLocaleString(intlLocale(locale.value));
const sources = computed(() => [{ source: 'home', name: t('nav.home') },
  ...connections.items.filter((c) => c.status === 'ok').map((c) => ({ source: c.source, name: t('nav.connection', { provider: c.providerName, account: c.account }) }))]);

// --- the form dialog: a new request or the one being edited ---
const editing = ref<FileRequest | 'new' | null>(null);
const source = ref('home'); const dir = ref('/');
// Vue casts a `type="number"` field's value to a number once something is typed; empty stays ''.
const label = ref(''); const expiry = ref(''); const maxFiles = ref<string | number>(''); const maxSize = ref<string | number>('');
const password = ref(''); const dropPassword = ref(false); const askName = ref(false);
const formError = ref(''); const busy = ref(false);
const formId = useId();
const newButton = ref<HTMLButtonElement>();
const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function open(r: FileRequest | 'new') {
  editing.value = r; formError.value = ''; status.value = ''; password.value = ''; dropPassword.value = false;
  source.value = 'home'; dir.value = '/';
  label.value = r === 'new' ? '' : r.label;
  expiry.value = r === 'new' || !r.expiresAt ? '' : localInput(r.expiresAt);
  maxFiles.value = r === 'new' || r.maxFiles === null ? '' : String(r.maxFiles);
  maxSize.value = r === 'new' || r.maxBytes === null ? '' : String(r.maxBytes / MB);
  askName.value = r === 'new' ? false : r.askName;
}
const numberOrNull = (v: string | number, scale = 1) => String(v).trim() === '' ? null : Math.round(Number(v) * scale);
function fields() {
  const typed = expiry.value.trim();
  const ms = typed ? new Date(typed).getTime() : NaN;
  return { label: label.value.trim(), expiresAt: typed === '' ? null : Number.isFinite(ms) ? new Date(ms).toISOString() : typed,
    maxFiles: numberOrNull(maxFiles.value), maxBytes: numberOrNull(maxSize.value, MB), askName: askName.value };
}
async function submit() {
  if (busy.value || editing.value === null) return; // not `disabled`: that would drop the focus out of the dialog
  busy.value = true; formError.value = '';
  try {
    if (editing.value === 'new') {
      const body: CreateFileRequest = { source: source.value, path: dir.value, ...fields(), password: password.value === '' ? null : password.value };
      await api.post<FileRequest>('/api/v1/requests', body);
      status.value = t('requests.created');
    } else {
      const body: UpdateFileRequest = { ...fields(),
        ...(dropPassword.value ? { password: null } : password.value !== '' ? { password: password.value } : {}) };
      await api.patch<FileRequest>(`/api/v1/requests/${encodeURIComponent(editing.value.id)}`, body);
      status.value = t('requests.saved');
    }
    editing.value = null;
    await requests.load();
  } catch (e) { fail(e, formError); } finally { busy.value = false; }
}

async function revoke(r: FileRequest) {
  error.value = ''; status.value = '';
  try {
    await api.delete(`/api/v1/requests/${encodeURIComponent(r.id)}`);
    await requests.load();
    status.value = t('requests.revoked', { name: nameOf(r) });
    await nextTick(); newButton.value?.focus(); // the focused button is gone with the request's actions
  } catch (e) { fail(e); }
}

// Visitors' unfinished uploads hold the member's quota (#304): dropped here, the request stays open.
async function discard(r: FileRequest) {
  error.value = ''; status.value = '';
  try {
    await api.delete(`/api/v1/requests/${encodeURIComponent(r.id)}/uploads`);
    await requests.load();
    status.value = t('requests.discarded', { name: nameOf(r) });
    await nextTick(); newButton.value?.focus(); // the focused button is gone once nothing is pending
  } catch (e) { fail(e); }
}

const inputs = new Map<string, HTMLInputElement>();
const setInput = (id: string, el: unknown) => { if (el instanceof HTMLInputElement) inputs.set(id, el); else inputs.delete(id); };
async function copy(r: FileRequest) {
  try {
    await navigator.clipboard.writeText(address(r));
    status.value = t('requests.copied');
  } catch {
    // handled: no clipboard (plain http, permission): the address is selected for the member to copy themselves
    const input = inputs.get(r.id);
    input?.focus(); input?.select();
    status.value = t('requests.copyManually');
  }
}

// --- the files dialog: what a request received; opening it marks them seen ---
const showing = ref<FileRequest | null>(null);
const received = ref<ReceivedFile[] | null>(null);
const filesError = ref('');
async function showFiles(r: FileRequest) {
  showing.value = r; received.value = null; filesError.value = '';
  try {
    received.value = (await api.get<ReceivedFileList>(`/api/v1/requests/${encodeURIComponent(r.id)}/files`)).items;
    if (received.value.some((f) => f.new)) {
      await api.post(`/api/v1/requests/${encodeURIComponent(r.id)}/seen`, {});
      await requests.load();
    }
  } catch (e) { fail(e, filesError); }
}
// A received file opens the request's folder with it selected, as from Recent (#235). An orphaned request's folder is
// gone, so nothing links there.
const fileTarget = (r: FileRequest, f: ReceivedFile) =>
  ({ path: folderRoute(r.source, r.path), query: { select: `${r.path.replace(/\/$/, '')}/${f.name}` } });
</script>

<template>
  <section class="page requests-page">
    <div class="toolbar">
      <h1 class="view-title">
        {{ t('requests.title') }}
      </h1>
      <button
        ref="newButton"
        type="button"
        class="button primary"
        @click="open('new')"
      >
        {{ t('requests.new') }}
      </button>
    </div>
    <p class="share-note">
      {{ t('requests.intro') }}
    </p>
    <p
      v-if="error"
      class="fs-field__error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-if="requests.loaded && requests.items.length === 0"
      class="recent-empty"
    >
      {{ t('requests.none') }}
    </p>
    <ul
      v-else
      class="fs-entry-list request-list"
      :aria-label="t('requests.title')"
    >
      <li
        v-for="r in requests.items"
        :key="r.id"
        :data-testid="`request-${r.id}`"
      >
        <span class="share-name">{{ nameOf(r) }}</span>
        <span
          v-if="r.newFiles > 0"
          class="request-badge"
        >{{ t('requests.newFiles', { count: r.newFiles }, r.newFiles) }}</span>
        <span class="share-level">
          {{ t('requests.into', { where: folderLabel(r.source, r.path) }) }} ·
          {{ t('requests.received', { count: r.files }, r.files) }}
          <template v-if="r.pending > 0"> · {{ t('requests.pending', { count: r.pending }, r.pending) }}</template>
          <template v-if="r.revoked"> · {{ t('requests.isRevoked') }}</template>
          <template v-else-if="r.orphaned"> · {{ t('requests.isOrphaned') }}</template>
          <template v-else-if="expired(r)"> · {{ t('requests.isExpired') }}</template>
        </span>
        <input
          v-if="!r.revoked && !r.orphaned"
          :ref="(el) => setInput(r.id, el)"
          class="fs-input link-address"
          type="text"
          readonly
          :value="address(r)"
          :aria-label="t('requests.address', { name: nameOf(r) })"
          @focus="($event.target as HTMLInputElement).select()"
        >
        <span class="link-buttons">
          <button
            v-if="!r.revoked && !r.orphaned"
            type="button"
            class="button"
            :aria-label="t('requests.copyLabel', { name: nameOf(r) })"
            @click="copy(r)"
          >
            {{ t('requests.copy') }}
          </button>
          <button
            type="button"
            class="button"
            :aria-label="t('requests.showLabel', { name: nameOf(r) })"
            @click="showFiles(r)"
          >
            {{ t('requests.show') }}
          </button>
          <button
            v-if="!r.revoked && !r.orphaned"
            type="button"
            class="button"
            :aria-label="t('requests.editLabel', { name: nameOf(r) })"
            @click="open(r)"
          >
            {{ t('requests.edit') }}
          </button>
          <button
            v-if="r.pending > 0"
            type="button"
            class="button"
            :aria-label="t('requests.discardLabel', { name: nameOf(r) })"
            @click="discard(r)"
          >
            {{ t('requests.discard') }}
          </button>
          <button
            v-if="!r.revoked"
            type="button"
            class="button danger"
            :aria-label="t('requests.revokeLabel', { name: nameOf(r) })"
            @click="revoke(r)"
          >
            {{ t('requests.revoke') }}
          </button>
        </span>
      </li>
    </ul>
    <p
      class="visually-hidden"
      aria-live="polite"
    >
      {{ status }}
    </p>

    <AppDialog
      v-if="editing"
      :title="editing === 'new' ? t('requests.new') : t('requests.editing', { name: nameOf(editing) })"
      @close="editing = null"
    >
      <form
        :id="formId"
        class="app-dialog-form request-form"
        @submit.prevent="submit"
      >
        <template v-if="editing === 'new'">
          <fieldset
            v-if="sources.length > 1"
            class="migrate-accounts"
          >
            <legend class="fs-label">
              {{ t('requests.source') }}
            </legend>
            <label
              v-for="s in sources"
              :key="s.source"
              class="migrate-radio"
            >
              <input
                v-model="source"
                type="radio"
                name="request-source"
                :value="s.source"
                @change="dir = '/'"
              >
              {{ s.name }}
            </label>
          </fieldset>
          <FolderPicker
            v-model="dir"
            :source="source"
            :root-label="sourceName(source)"
            :label="t('requests.folders')"
          />
          <p class="migrate-choice">
            {{ t('requests.target', { where: folderLabel(source, dir) }) }}
          </p>
        </template>
        <div class="app-dialog-field">
          <label
            class="fs-label"
            :for="`${formId}-label`"
          >{{ t('requests.label') }}</label>
          <input
            :id="`${formId}-label`"
            v-model="label"
            class="fs-input"
            type="text"
            maxlength="100"
            :aria-describedby="`${formId}-label-hint`"
          >
          <p
            :id="`${formId}-label-hint`"
            class="share-note"
          >
            {{ t('requests.labelHint') }}
          </p>
        </div>
        <div class="app-dialog-field">
          <label
            class="fs-label"
            :for="`${formId}-expiry`"
          >{{ t('requests.expiry') }}</label>
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
            {{ t('requests.expiryHint') }}
          </p>
        </div>
        <div class="app-dialog-field">
          <label
            class="fs-label"
            :for="`${formId}-files`"
          >{{ t('requests.maxFiles') }}</label>
          <input
            :id="`${formId}-files`"
            v-model="maxFiles"
            class="fs-input"
            type="number"
            min="1"
            step="1"
            inputmode="numeric"
            :max="MAX_REQUEST_FILES"
            :placeholder="t('requests.maxFilesPlaceholder', { max: fmtCount(MAX_REQUEST_FILES) })"
            :aria-describedby="`${formId}-limit-hint`"
          >
        </div>
        <div class="app-dialog-field">
          <label
            class="fs-label"
            :for="`${formId}-size`"
          >{{ t('requests.maxSize') }}</label>
          <input
            :id="`${formId}-size`"
            v-model="maxSize"
            class="fs-input"
            type="number"
            min="1"
            step="any"
            inputmode="decimal"
            :aria-describedby="`${formId}-limit-hint`"
          >
          <p
            :id="`${formId}-limit-hint`"
            class="share-note"
          >
            {{ t('requests.limitHint', { max: fmtCount(MAX_REQUEST_FILES), perSender: fmtCount(MAX_REQUEST_FILES_PER_VISITOR) }) }}
          </p>
        </div>
        <div class="app-dialog-field">
          <label
            class="fs-label"
            :for="`${formId}-password`"
          >{{ t('requests.password') }}</label>
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
            {{ editing !== 'new' && editing.hasPassword ? t('requests.passwordKeep') : t('requests.passwordHint') }}
          </p>
          <label
            v-if="editing !== 'new' && editing.hasPassword"
            class="app-dialog-check"
          >
            <input
              v-model="dropPassword"
              type="checkbox"
            >
            {{ t('requests.removePassword') }}
          </label>
        </div>
        <label class="app-dialog-check">
          <input
            v-model="askName"
            type="checkbox"
          >
          {{ t('requests.askName') }}
        </label>
        <p
          v-if="formError"
          class="fs-field__error"
          role="alert"
        >
          {{ formError }}
        </p>
        <div class="app-dialog-actions">
          <button
            type="button"
            class="button"
            @click="editing = null"
          >
            {{ t('requests.cancel') }}
          </button>
          <button
            type="submit"
            class="button primary"
            :aria-disabled="busy"
          >
            {{ editing === 'new' ? t('requests.create') : t('requests.save') }}
          </button>
        </div>
      </form>
    </AppDialog>

    <AppDialog
      v-if="showing"
      :title="t('requests.filesTitle', { name: nameOf(showing) })"
      @close="showing = null"
    >
      <p
        v-if="filesError"
        class="fs-field__error"
        role="alert"
      >
        {{ filesError }}
      </p>
      <p v-else-if="received === null">
        {{ t('folder.loading') }}
      </p>
      <p
        v-else-if="received.length === 0"
        class="recent-empty"
      >
        {{ t('requests.noFiles') }}
      </p>
      <ul
        v-else
        class="fs-entry-list received-list"
        :aria-label="t('requests.filesTitle', { name: nameOf(showing) })"
      >
        <li
          v-for="(f, i) in received"
          :key="`${i}-${f.name}`"
        >
          <span
            class="icon icon-file"
            aria-hidden="true"
          />
          <RouterLink
            v-if="!showing.orphaned"
            class="share-name"
            :to="fileTarget(showing, f)"
          >
            {{ f.name }}
          </RouterLink>
          <span
            v-else
            class="share-name"
          >{{ f.name }}</span>
          <span
            v-if="f.new"
            class="request-badge"
          >{{ t('requests.isNew') }}</span>
          <span class="share-level value-mono">{{ fmtSize(f.size) }}</span>
          <span
            v-if="f.uploader"
            class="share-level"
          >{{ t('requests.from', { name: f.uploader }) }}</span>
          <span class="share-level value-mono">{{ fmtDate(f.receivedAt) }}</span>
        </li>
      </ul>
      <div class="app-dialog-actions">
        <RouterLink
          v-if="!showing.orphaned"
          class="button"
          :to="folderRoute(showing.source, showing.path)"
        >
          {{ t('requests.openFolder') }}
        </RouterLink>
        <button
          type="button"
          class="button"
          @click="showing = null"
        >
          {{ t('requests.close') }}
        </button>
      </div>
    </AppDialog>
  </section>
</template>
