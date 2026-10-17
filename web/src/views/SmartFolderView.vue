<script setup lang="ts">
// A smart folder's page (#214): the live result of its saved query, asked anew on every open, one group per source like
// global search. Each group is the folder list: a folder opens itself, a file the preview; download, details (with the
// tags) and the star are in the item menu. A source that failed or ran out of time says so in its own group, the others
// still show. "Edit" changes the query, "Rename" the name, "Delete" removes it after a confirmation.
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { Entry, SearchGroup, SmartResults } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { downloadHref, folderRoute } from '../api/paths.ts';
import { useLocations } from '../location.ts';
import type { ItemAction } from '../itemActions.ts';
import { useConnectionsStore } from '../stores/connections.ts';
import { useFavouritesStore } from '../stores/favourites.ts';
import { useSmartFoldersStore } from '../stores/smartFolders.ts';
import FileList from '../components/FileList.vue';
import DetailsDrawer from '../components/DetailsDrawer.vue';
import ShareDialog from '../components/ShareDialog.vue';
import PreviewDialog from '../components/PreviewDialog.vue';
import RenameDialog from '../components/RenameDialog.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import SmartFolderDialog from '../components/SmartFolderDialog.vue';
import RowSkeleton from '../components/RowSkeleton.vue';
import StateAlert from '../components/StateAlert.vue';
import ActionToast, { type Toast } from '../components/ActionToast.vue';

const { t } = useI18n();
const route = useRoute(); const router = useRouter();
const store = useSmartFoldersStore();
const favourites = useFavouritesStore();
const connections = useConnectionsStore();
const { sourceName, sourceAccount } = useLocations();
const id = computed(() => String(route.params.id));
const folder = computed(() => store.byId(id.value));
const groups = ref<SearchGroup[] | null>(null);
const error = ref<ApiFailure | null>(null);
const selected = ref<Record<string, string[]>>({});
const toast = ref<Toast | null>(null);
let toastId = 0;
const say = (text: string, kind: Toast['kind'] = 'success') => { toast.value = { text, kind, id: ++toastId }; };
let seq = 0;

async function load() {
  const mine = ++seq;
  error.value = null;
  try {
    const r = await api.get<SmartResults>(`/api/v1/smart-folders/${id.value}/results`);
    if (mine === seq) groups.value = r.groups;
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    if (mine === seq) { error.value = e; groups.value = null; }
  }
}
watch(id, () => {
  groups.value = null; selected.value = {}; toast.value = null;
  if (!store.loaded) void store.load();
  void load();
}, { immediate: true });

const missing = computed(() => error.value?.code === 'NOT_FOUND' || (store.loaded && !store.error && !folder.value));
const empty = computed(() => groups.value !== null && groups.value.every((g) => g.items.length === 0 && !g.error));
// In a sentence a connection is named like its sidebar entry (#148), provider and account.
const sourceLabel = (source: string) => {
  const c = connections.bySource(source);
  return c ? t('nav.connection', { provider: c.providerName, account: c.account }) : sourceName(source);
};
const starred = (source: string) => favourites.items.filter((f) => f.source === source).map((f) => f.path);

const details = ref<{ source: string; entry: Entry } | null>(null);
// A restored version (#231): the open drawer shows the restored file at once; the results are fetched again.
function onRestored(entry: Entry) {
  if (details.value) details.value = { source: details.value.source, entry };
  void load();
}
const sharing = ref<{ source: string; entry: Entry } | null>(null);
const preview = ref<{ source: string; files: Entry[]; start: number } | null>(null);
function open(source: string, e: Entry, items: Entry[]) {
  if (e.type === 'directory') { void router.push(folderRoute(source, e.path)); return; }
  const files = items.filter((x) => x.type === 'file');
  preview.value = { source, files, start: files.findIndex((x) => x.path === e.path) };
}
async function onAction(source: string, action: ItemAction, entries: Entry[]) {
  if (action === 'details') details.value = { source, entry: entries[0]! };
  else if (action === 'download') {
    const a = document.createElement('a');
    a.href = downloadHref(source, entries); a.download = ''; a.click();
  } else if (action === 'favourite') {
    try {
      const now = await favourites.toggle(source, entries[0]!.path);
      say(t(now ? 'favourites.added' : 'favourites.removed', { name: entries[0]!.name }));
    } catch (e) {
      if (!(e instanceof ApiFailure)) throw e;
      say(t(`errors.${e.code}`), 'error');
    }
  }
}

const editing = ref(false);
const renaming = ref<{ error: string | null; busy: boolean } | null>(null);
const deleting = ref(false);
function saved() { editing.value = false; void load(); say(t('smart.saved')); }
async function rename(name: string) {
  const f = folder.value!;
  const r = renaming.value!;
  r.error = null; r.busy = true;
  try { await store.update(f.id, { name, query: f.query }); }
  catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    r.error = t(`errors.${e.code}`); r.busy = false;
    return;
  }
  renaming.value = null;
  say(t('smart.renamed', { name }));
}
async function remove() {
  const f = folder.value!;
  deleting.value = false;
  try { await store.remove(f.id); }
  catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    say(t(`errors.${e.code}`), 'error');
    return;
  }
  await router.push('/home');
}
</script>

<template>
  <section class="page smart-folder">
    <StateAlert
      v-if="missing"
      :title="$t('smart.notFound')"
      :text="$t('errors.NOT_FOUND')"
    >
      <RouterLink
        class="button primary"
        to="/home"
      >
        {{ $t('nav.toHome') }}
      </RouterLink>
    </StateAlert>
    <template v-else>
      <div class="toolbar">
        <h1
          class="view-title"
          tabindex="-1"
        >
          {{ folder?.name ?? '' }}
        </h1>
        <div
          v-if="folder"
          class="toolbar-actions"
        >
          <button
            type="button"
            class="button"
            @click="editing = true"
          >
            {{ $t('smart.edit') }}
          </button>
          <button
            type="button"
            class="button"
            @click="renaming = { error: null, busy: false }"
          >
            {{ $t('actions.rename') }}
          </button>
          <button
            type="button"
            class="button danger"
            @click="deleting = true"
          >
            {{ $t('smart.delete') }}
          </button>
        </div>
      </div>
      <p
        v-if="error"
        role="alert"
      >
        {{ $t(`errors.${error.code}`) }}
      </p>
      <RowSkeleton v-else-if="!groups" />
      <p
        v-else-if="empty"
        class="favourites-empty"
      >
        {{ $t('smart.empty') }}
      </p>
      <template v-if="groups">
        <section
          v-for="g in groups.filter((x) => x.items.length || x.error)"
          :key="g.source"
          class="smart-group"
          :aria-label="sourceLabel(g.source)"
        >
          <h2 class="smart-group-title">
            <span class="search-group-source">{{ sourceName(g.source) }}</span>
            <span
              v-if="sourceAccount(g.source)"
              class="search-group-account"
            >{{ sourceAccount(g.source) }}</span>
          </h2>
          <p
            v-if="g.error"
            class="smart-failed"
          >
            {{ $t('search.sourceFailed', { source: sourceLabel(g.source), reason: $t(`errors.${g.error.code}`) }) }}
          </p>
          <FileList
            v-else
            v-model:selected="selected[g.source]"
            :entries="g.items"
            :folder-name="sourceLabel(g.source)"
            :source="g.source"
            :editable="false"
            :starred="starred(g.source)"
            @open="open(g.source, $event, g.items)"
            @action="(a, es) => onAction(g.source, a, es)"
          />
          <p
            v-if="g.more"
            class="search-note"
          >
            {{ $t('smart.more') }}
          </p>
        </section>
      </template>
    </template>
    <SmartFolderDialog
      v-if="editing && folder"
      :editing="folder"
      @saved="saved"
      @cancel="editing = false"
    />
    <RenameDialog
      v-if="renaming && folder"
      :name="folder.name"
      is-folder
      :error="renaming.error"
      :busy="renaming.busy"
      @submit="rename"
      @cancel="renaming = null"
    />
    <ConfirmDialog
      v-if="deleting && folder"
      :title="$t('smart.deleteTitle')"
      :message="$t('smart.deleteMessage', { name: folder.name })"
      :confirm-label="$t('smart.delete')"
      @confirm="remove"
      @cancel="deleting = false"
    />
    <DetailsDrawer
      v-if="details"
      :source="details.source"
      :entry="details.entry"
      access="edit"
      :root-label="sourceName(details.source)"
      @close="details = null"
      @share="sharing = details; details = null"
      @restored="onRestored"
    />
    <ShareDialog
      v-if="sharing"
      :source="sharing.source"
      :entry="sharing.entry"
      @close="sharing = null"
    />
    <PreviewDialog
      v-if="preview"
      :files="preview.files"
      :start="preview.start"
      :source="preview.source"
      @close="preview = null"
    />
    <ActionToast
      :toast="toast"
      @dismiss="toast = null"
    />
  </section>
</template>
