<script setup lang="ts">
// Settings (#157): how to mount the shard home as a network drive over WebDAV, and the member's app passwords for it.
// A new password is shown once in a dialog; the list never holds it. A create the server refuses (the limit) is shown
// in the alert line and the form keeps what was typed (#122).
import { computed, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppPassword, CreatedAppPassword } from '@files/shared';
import { useAppPasswordsStore } from '../stores/appPasswords.ts';
import { ApiFailure } from '../api/client.ts';
import { formatDate, intlLocale } from '../format.ts';
import AppDialog from '../components/AppDialog.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';

const { t, locale } = useI18n();
const store = useAppPasswordsStore();
const address = computed(() => new URL('/dav/', location.origin).href);
const label = ref('');
const invalid = ref(false);
const busy = ref(false);
const status = ref('');
const alert = ref('');
const created = ref<CreatedAppPassword | null>(null);
const revoking = ref<AppPassword | null>(null);
const createButton = ref<HTMLButtonElement>();
const passwordInput = ref<HTMLInputElement>();
const ids = { webdav: useId(), passwords: useId(), label: useId(), labelError: useId(), address: useId(), password: useId() };
onMounted(() => { void store.load(); });

const date = (iso: string) => formatDate(iso, intlLocale(locale.value));

function fail(e: unknown) {
  if (!(e instanceof ApiFailure)) throw e;
  alert.value = t(`errors.${e.code}`, e.params ?? {});
}

async function create() {
  status.value = ''; alert.value = '';
  invalid.value = label.value.trim() === '';
  if (invalid.value || busy.value) return;
  busy.value = true;
  try {
    created.value = await store.create(label.value.trim());
    status.value = t('appPasswords.created', { label: created.value.item.label });
    label.value = '';
  } catch (e) { fail(e); } // handled: a refusal stays visible in the alert line, the form keeps its text
  finally { busy.value = false; }
}

// The password leaves memory with the dialog; the list then shows when it was first used.
function closeCreated() {
  created.value = null;
  void store.load();
}

async function copy() {
  if (!created.value) return;
  try {
    await navigator.clipboard.writeText(created.value.password);
    status.value = t('appPasswords.copied');
  } catch {
    // handled: no clipboard (plain http, permission): the password is selected for the member to copy themselves
    passwordInput.value?.focus(); passwordInput.value?.select();
    status.value = t('appPasswords.copyManually');
  }
}

async function revoke() {
  const item = revoking.value;
  revoking.value = null;
  if (!item) return;
  status.value = ''; alert.value = '';
  try {
    await store.revoke(item.id);
    status.value = t('appPasswords.revoked', { label: item.label });
  } catch (e) { fail(e); } // handled: shown in the alert line
  createButton.value?.focus(); // the focused button is gone with its row
}
</script>

<template>
  <section class="recent settings">
    <div class="toolbar">
      <h1
        class="view-title"
        tabindex="-1"
      >
        {{ $t('settings.title') }}
      </h1>
    </div>

    <section
      class="settings-section"
      :aria-labelledby="ids.webdav"
    >
      <h2
        :id="ids.webdav"
        class="settings-heading"
      >
        {{ $t('settings.webdav.heading') }}
      </h2>
      <p class="trash-note">
        {{ $t('settings.webdav.intro') }}
      </p>
      <div class="app-dialog-field settings-field">
        <label :for="ids.address">{{ $t('settings.webdav.address') }}</label>
        <input
          :id="ids.address"
          class="fs-input settings-mono"
          type="text"
          readonly
          :value="address"
          @focus="($event.target as HTMLInputElement).select()"
        >
      </div>
      <p class="trash-note">
        {{ $t('settings.webdav.username') }}
      </p>
    </section>

    <section
      class="settings-section app-passwords"
      :aria-labelledby="ids.passwords"
    >
      <h2
        :id="ids.passwords"
        class="settings-heading"
      >
        {{ $t('appPasswords.heading') }}
      </h2>
      <p
        class="status"
        role="status"
        aria-live="polite"
      >
        {{ status }}
      </p>
      <p
        v-if="alert"
        role="alert"
        class="settings-alert"
      >
        {{ alert }}
      </p>
      <form
        class="settings-form"
        novalidate
        @submit.prevent="create"
      >
        <div class="app-dialog-field settings-field">
          <label :for="ids.label">{{ $t('appPasswords.label') }}</label>
          <input
            :id="ids.label"
            v-model="label"
            class="fs-input"
            type="text"
            maxlength="100"
            autocomplete="off"
            :aria-invalid="invalid ? 'true' : undefined"
            :aria-describedby="invalid ? ids.labelError : undefined"
          >
          <span
            v-if="invalid"
            :id="ids.labelError"
            class="fs-field__error"
          >{{ $t('appPasswords.invalid') }}</span>
        </div>
        <button
          ref="createButton"
          type="submit"
          class="button primary"
          :disabled="busy"
        >
          {{ $t('appPasswords.create') }}
        </button>
      </form>

      <p v-if="!store.loaded">
        {{ $t('folder.loading') }}
      </p>
      <p
        v-else-if="store.error"
        role="alert"
      >
        {{ $t(`errors.${store.error.code}`) }}
      </p>
      <p
        v-else-if="store.items.length === 0"
        class="trash-note"
      >
        {{ $t('appPasswords.empty') }}
      </p>
      <table
        v-else
        class="file-list trash-list"
        :aria-label="$t('appPasswords.heading')"
      >
        <thead>
          <tr>
            <th scope="col">
              {{ $t('appPasswords.columns.label') }}
            </th>
            <th scope="col">
              {{ $t('appPasswords.columns.created') }}
            </th>
            <th scope="col">
              {{ $t('appPasswords.columns.lastUsed') }}
            </th>
            <th scope="col">
              {{ $t('appPasswords.columns.actions') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="p in store.items"
            :key="p.id"
          >
            <td class="name">
              <div class="name-inner">
                <span
                  class="icon icon-key"
                  aria-hidden="true"
                />
                {{ p.label }}
              </div>
            </td>
            <td class="date">
              {{ date(p.createdAt) }}
            </td>
            <td class="date">
              {{ p.lastUsedAt ? $t('appPasswords.lastUsed', { date: date(p.lastUsedAt) }) : $t('appPasswords.never') }}
            </td>
            <td class="actions">
              <button
                type="button"
                class="button"
                :aria-label="$t('appPasswords.revokeLabel', { label: p.label })"
                @click="revoking = p"
              >
                {{ $t('appPasswords.revoke') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <AppDialog
      v-if="created"
      :title="$t('appPasswords.shownTitle', { label: created.item.label })"
      :return-focus="createButton"
      @close="closeCreated"
    >
      <p class="app-dialog-text">
        {{ $t('appPasswords.shownText') }}
      </p>
      <div class="app-dialog-field">
        <label :for="ids.password">{{ $t('appPasswords.password') }}</label>
        <input
          :id="ids.password"
          ref="passwordInput"
          class="fs-input settings-mono"
          type="text"
          readonly
          autocomplete="off"
          spellcheck="false"
          :value="created.password"
          data-autofocus
          @focus="($event.target as HTMLInputElement).select()"
        >
      </div>
      <template #actions>
        <button
          type="button"
          class="button"
          @click="copy"
        >
          {{ $t('appPasswords.copy') }}
        </button>
        <button
          type="button"
          class="button primary"
          @click="closeCreated"
        >
          {{ $t('appPasswords.done') }}
        </button>
      </template>
    </AppDialog>

    <ConfirmDialog
      v-if="revoking"
      :title="$t('appPasswords.revokeTitle', { label: revoking.label })"
      :message="$t('appPasswords.revokeMessage')"
      :confirm-label="$t('appPasswords.revoke')"
      @confirm="revoke"
      @cancel="revoking = null"
    />
  </section>
</template>
