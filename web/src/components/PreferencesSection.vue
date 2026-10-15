<script setup lang="ts">
// Language and theme (#159). A change is saved at once and applied when the server has confirmed it, so the choice
// follows the member to every device. A refused save is shown in the alert line and the radios go back to the stored
// choice (#122). Saves run one after another, so the last choice is the one stored.
import { ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { LOCALES, THEMES, type Locale, type Theme } from '@files/shared';
import { useSettingsStore } from '../stores/settings.ts';
import { ApiFailure } from '../api/client.ts';
import { htmlLangFor } from '../i18n/htmlLang.ts';

const { t } = useI18n();
const store = useSettingsStore();
const AUTO = 'auto';
const locale = ref<Locale | typeof AUTO>(store.locale ?? AUTO);
const theme = ref<Theme>(store.theme);
const status = ref('');
const alert = ref('');
const ids = { heading: useId(), language: useId(), theme: useId() };

let queue: Promise<void> = Promise.resolve();
function save() {
  const next = { locale: locale.value === AUTO ? null : locale.value, theme: theme.value };
  status.value = ''; alert.value = '';
  queue = queue.then(async () => {
    try {
      await store.save(next);
      status.value = t('settings.saved');
    } catch (e) { // handled: shown in the alert line; the radios return to what is stored
      if (!(e instanceof ApiFailure)) throw e;
      alert.value = t(`errors.${e.code}`, e.params ?? {});
      locale.value = store.locale ?? AUTO;
      theme.value = store.theme;
    }
  });
}
</script>

<template>
  <section
    class="settings-section preferences"
    :aria-labelledby="ids.heading"
  >
    <h2
      :id="ids.heading"
      class="settings-heading"
    >
      {{ $t('settings.preferences.heading') }}
    </h2>
    <p class="trash-note">
      {{ $t('settings.preferences.intro') }}
    </p>
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
    <fieldset class="settings-choices">
      <legend class="fs-label">
        {{ $t('settings.language.heading') }}
      </legend>
      <label class="settings-radio">
        <input
          v-model="locale"
          type="radio"
          :name="ids.language"
          :value="AUTO"
          @change="save"
        >
        {{ $t('settings.language.auto') }}
      </label>
      <label
        v-for="l in LOCALES"
        :key="l"
        class="settings-radio"
        :lang="htmlLangFor(l)"
      >
        <input
          v-model="locale"
          type="radio"
          :name="ids.language"
          :value="l"
          @change="save"
        >
        {{ $t(`settings.language.names.${l}`) }}
      </label>
    </fieldset>
    <fieldset class="settings-choices">
      <legend class="fs-label">
        {{ $t('settings.theme.heading') }}
      </legend>
      <label
        v-for="th in THEMES"
        :key="th"
        class="settings-radio"
      >
        <input
          v-model="theme"
          type="radio"
          :name="ids.theme"
          :value="th"
          @change="save"
        >
        {{ $t(`settings.theme.${th}`) }}
      </label>
    </fieldset>
  </section>
</template>
