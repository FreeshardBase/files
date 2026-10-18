<script setup lang="ts">
// "Use on iPhone and Android" (#321): what a phone's WebDAV app asks for (the address, or server and path, the
// member's login as the user name, an app password created right here and shown once), the steps for two iOS apps
// that then appear in the Files app and two Android apps, and why there is no SMB.
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CreatedAppPassword } from '@files/shared';
import { useAppPasswordsStore } from '../stores/appPasswords.ts';
import { useSessionStore } from '../stores/session.ts';
import { ApiFailure } from '../api/client.ts';
import AppDialog from '../components/AppDialog.vue';

const { t } = useI18n();
const store = useAppPasswordsStore();
const session = useSessionStore();
const fields = computed(() => [
  { key: 'address', value: new URL('/dav/', location.origin).href },
  { key: 'server', value: location.host },
  { key: 'path', value: '/dav/' },
  ...(session.me?.login ? [{ key: 'username', value: session.me.login }] : []),
]);
// The steps of each app, `phone.apps.<key>.steps.1` to `.<n>` with the app's name as `{app}`. The names are the
// products' own and the same in every language, so they are not in the locale files.
const APPS = [
  { key: 'readdle', name: 'Documents by Readdle', platform: 'ios', steps: 4 },
  { key: 'fe', name: 'FE File Explorer', platform: 'ios', steps: 4 },
  { key: 'solid', name: 'Solid Explorer', platform: 'android', steps: 4 },
  { key: 'material', name: 'Material Files', platform: 'android', steps: 4 },
] as const;
const label = ref('');
const invalid = ref(false);
const busy = ref(false);
const status = ref('');
const alert = ref('');
const created = ref<CreatedAppPassword | null>(null);
const createButton = ref<HTMLButtonElement>();
const passwordInput = ref<HTMLInputElement>();
const ids = { access: useId(), apps: useId(), smb: useId(), label: useId(), labelError: useId(), password: useId(),
  field: (key: string) => `phone-${key}` };

async function create() {
  status.value = ''; alert.value = '';
  invalid.value = label.value.trim() === '';
  if (invalid.value || busy.value) return;
  busy.value = true;
  try {
    created.value = await store.create(label.value.trim());
    status.value = t('appPasswords.created', { label: created.value.item.label });
    label.value = '';
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    alert.value = t(`errors.${e.code}`, e.params ?? {}); // handled: a refusal stays visible, the form keeps its text
  } finally { busy.value = false; }
}

async function copy(value: string, input: HTMLInputElement | null) {
  try {
    await navigator.clipboard.writeText(value);
    status.value = t('appPasswords.copied');
  } catch {
    // handled: no clipboard (plain http, permission): the text is selected for the member to copy themselves
    input?.focus(); input?.select();
    status.value = t('phone.copyManually');
  }
}
const inputOf = (key: string) => document.getElementById(ids.field(key)) as HTMLInputElement | null;
</script>

<template>
  <section class="page page-narrow settings phone-setup">
    <div class="toolbar">
      <h1
        class="view-title"
        tabindex="-1"
      >
        {{ $t('phone.title') }}
      </h1>
    </div>
    <p>
      <RouterLink :to="{ name: 'settings' }">
        {{ $t('phone.back') }}
      </RouterLink>
    </p>
    <p class="trash-note">
      {{ $t('phone.intro') }}
    </p>
    <p
      class="status"
      role="status"
      aria-live="polite"
    >
      {{ status }}
    </p>

    <section
      class="settings-section"
      :aria-labelledby="ids.access"
    >
      <h2
        :id="ids.access"
        class="settings-heading"
      >
        {{ $t('phone.access.heading') }}
      </h2>
      <div
        v-for="f in fields"
        :key="f.key"
        class="app-dialog-field settings-field"
      >
        <label
          class="fs-label"
          :for="ids.field(f.key)"
        >{{ $t(`phone.access.${f.key}`) }}</label>
        <div class="phone-copy">
          <input
            :id="ids.field(f.key)"
            class="fs-input settings-mono"
            type="text"
            readonly
            spellcheck="false"
            :value="f.value"
            @focus="($event.target as HTMLInputElement).select()"
          >
          <button
            type="button"
            class="button"
            :aria-label="$t('phone.copyLabel', { field: $t(`phone.access.${f.key}`) })"
            @click="copy(f.value, inputOf(f.key))"
          >
            {{ $t('appPasswords.copy') }}
          </button>
        </div>
      </div>
      <p class="trash-note">
        {{ session.me?.login ? $t('phone.access.usernameHint') : $t('settings.webdav.username') }}
      </p>
      <p class="trash-note">
        {{ $t('phone.access.passwordHint') }}
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
          <label
            class="fs-label"
            :for="ids.label"
          >{{ $t('appPasswords.label') }}</label>
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
    </section>

    <section
      class="settings-section"
      :aria-labelledby="ids.apps"
    >
      <h2
        :id="ids.apps"
        class="settings-heading"
      >
        {{ $t('phone.apps.heading') }}
      </h2>
      <section
        v-for="app in APPS"
        :key="app.key"
        class="phone-app"
      >
        <h3 class="phone-app-name">
          {{ app.name }}
        </h3>
        <p class="trash-note">
          {{ $t(`phone.platform.${app.platform}`) }}
        </p>
        <ol class="phone-steps">
          <li
            v-for="i in app.steps"
            :key="i"
          >
            {{ $t(`phone.apps.${app.key}.steps.${i}`, { app: app.name }) }}
          </li>
        </ol>
      </section>
    </section>

    <section
      class="settings-section"
      :aria-labelledby="ids.smb"
    >
      <h2
        :id="ids.smb"
        class="settings-heading"
      >
        {{ $t('phone.smb.heading') }}
      </h2>
      <p class="trash-note">
        {{ $t('phone.smb.text') }}
      </p>
    </section>

    <AppDialog
      v-if="created"
      :title="$t('appPasswords.shownTitle', { label: created.item.label })"
      :return-focus="createButton"
      @close="created = null"
    >
      <p class="app-dialog-text">
        {{ $t('appPasswords.shownText') }}
      </p>
      <div class="app-dialog-field">
        <label
          class="fs-label"
          :for="ids.password"
        >{{ $t('appPasswords.password') }}</label>
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
          @click="copy(created.password, passwordInput ?? null)"
        >
          {{ $t('appPasswords.copy') }}
        </button>
        <button
          type="button"
          class="button primary"
          @click="created = null"
        >
          {{ $t('appPasswords.done') }}
        </button>
      </template>
    </AppDialog>
  </section>
</template>
