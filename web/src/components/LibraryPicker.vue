<script setup lang="ts">
// The SharePoint library picker (#151): after the consent, the member finds a site, chooses one of its document
// libraries, and the connection shows that library from then on. Sites and libraries come from the shard, which asks
// Microsoft; nothing here talks to Microsoft or asks for a token.
import { onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Connection, Library, Site } from '@files/shared';
import { useConnectionsStore } from '../stores/connections.ts';
import { ApiFailure } from '../api/client.ts';
import AppDialog from './AppDialog.vue';

const props = defineProps<{ connection: Connection }>();
const emit = defineEmits<{ close: []; picked: [Connection] }>();
const { t } = useI18n();
const connections = useConnectionsStore();
const queryId = useId();
const query = ref('');
const sites = ref<Site[] | null>(null);
const site = ref('');
const libraries = ref<Library[] | null>(null);
const library = ref('');
const busy = ref(false);
const error = ref('');
let seq = 0; // only the newest site or library request may touch state

const fail = (e: unknown) => {
  if (!(e instanceof ApiFailure)) throw e;
  error.value = t(`errors.${e.code}`);
};

async function search() {
  const id = ++seq;
  error.value = ''; sites.value = null; site.value = ''; libraries.value = null; library.value = '';
  try {
    const found = await connections.sites(props.connection.id, query.value.trim());
    if (id === seq) sites.value = found;
  } catch (e) { if (id === seq) { sites.value = []; fail(e); } } // handled: shown in the alert line
}

async function chooseSite() {
  const id = ++seq;
  error.value = ''; libraries.value = null; library.value = '';
  try {
    const found = await connections.libraries(props.connection.id, site.value);
    if (id === seq) libraries.value = found;
  } catch (e) { if (id === seq) { libraries.value = []; fail(e); } } // handled: shown in the alert line
}

async function connect() {
  if (!library.value || busy.value) return;
  busy.value = true; error.value = '';
  try { emit('picked', await connections.pickLibrary(props.connection.id, { site: site.value, library: library.value })); }
  catch (e) { fail(e); } // handled: shown in the alert line; the dialog stays open for another choice
  finally { busy.value = false; }
}

onMounted(search);
</script>

<template>
  <AppDialog
    :title="t('library.title')"
    @close="emit('close')"
  >
    <p class="app-dialog-text">
      {{ t('library.intro', { account: connection.account }) }}
    </p>
    <form
      class="app-dialog-form library-search"
      role="search"
      @submit.prevent="search"
    >
      <label
        class="fs-label"
        :for="queryId"
      >{{ t('library.search') }}</label>
      <div class="library-search-row">
        <input
          :id="queryId"
          v-model="query"
          class="fs-input"
          type="search"
          autocomplete="off"
          spellcheck="false"
          data-autofocus
        >
        <button
          type="submit"
          class="button"
        >
          {{ t('library.searchButton') }}
        </button>
      </div>
    </form>
    <p
      v-if="sites === null"
      class="share-note"
    >
      {{ t('folder.loading') }}
    </p>
    <p
      v-else-if="sites.length === 0"
      class="share-note"
    >
      {{ t('library.noSites') }}
    </p>
    <fieldset
      v-else
      class="library-choice"
    >
      <legend class="fs-label">
        {{ t('library.sites') }}
      </legend>
      <label
        v-for="s in sites"
        :key="s.id"
        class="share-radio library-option"
      >
        <input
          v-model="site"
          type="radio"
          name="library-site"
          :value="s.id"
          @change="chooseSite"
        >
        <span class="library-option-text">
          {{ s.name }}
          <span class="library-url">{{ s.url }}</span>
        </span>
      </label>
    </fieldset>
    <template v-if="site">
      <p
        v-if="libraries === null"
        class="share-note"
      >
        {{ t('folder.loading') }}
      </p>
      <p
        v-else-if="libraries.length === 0"
        class="share-note"
      >
        {{ t('library.noLibraries') }}
      </p>
      <fieldset
        v-else
        class="library-choice"
      >
        <legend class="fs-label">
          {{ t('library.libraries') }}
        </legend>
        <label
          v-for="l in libraries"
          :key="l.id"
          class="share-radio library-option"
        >
          <input
            v-model="library"
            type="radio"
            name="library-library"
            :value="l.id"
          >
          {{ l.name }}
        </label>
      </fieldset>
    </template>
    <p
      v-if="error"
      class="fs-field__error"
      role="alert"
    >
      {{ error }}
    </p>
    <template #actions>
      <button
        type="button"
        class="button primary"
        :disabled="!library || busy"
        @click="connect"
      >
        {{ t('library.connect') }}
      </button>
      <button
        type="button"
        class="button"
        @click="emit('close')"
      >
        {{ t('trash.cancel') }}
      </button>
    </template>
  </AppDialog>
</template>
