<script setup lang="ts">
// "Import an export archive" (#322): ZIPs of an iCloud Drive export, a Google Takeout or any ZIP, uploaded into (or
// already lying in) a home folder, extracted there by a transfer job of kind `import`. The page follows the job and lists
// what it imported, skipped (photo exports go to Immich) and failed.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Entry, TransferJob } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { useTransfersStore } from '../stores/transfers.ts';
import { useUploadsStore } from '../stores/uploads.ts';
import { join } from '../stores/folder.ts';
import { folderRoute } from '../api/paths.ts';
import FolderPicker from '../components/FolderPicker.vue';

const { t } = useI18n();
const transfers = useTransfersStore();
const uploads = useUploadsStore();

const dir = ref('/');
const zips = ref<string[]>([]);
const picked = ref<string[]>([]);
const alert = ref('');
const busy = ref(false);
const jobId = ref('');
// The job this page started, or else the member's latest import (#354): the report outlives the page, and the panel row
// of an import links back here.
const job = computed<TransferJob | undefined>(() => (jobId.value
  ? transfers.jobs.find((j) => j.id === jobId.value)
  : transfers.jobs.find((j) => j.kind === 'import')));
const files = ref<HTMLInputElement>();

const report = (e: unknown) => {
  if (!(e instanceof ApiFailure)) throw e;
  alert.value = t(`errors.${e.code}`);
};

async function listZips() {
  const at = dir.value;
  try {
    const page = await api.get<{ entries: Entry[] }>('/api/v1/sources/home/list', { path: at });
    if (at !== dir.value) return;
    zips.value = page.entries.filter((e) => e.type === 'file' && e.name.toLowerCase().endsWith('.zip')).map((e) => e.name);
    picked.value = picked.value.filter((n) => zips.value.includes(n));
  } catch (e) { report(e); } // handled: shown in the alert line
}
watch(dir, () => { picked.value = []; void listZips(); }, { immediate: true });

function upload() {
  const list = [...(files.value?.files ?? [])];
  if (!list.length) return;
  const at = dir.value;
  uploads.enqueue(list.map((file) => ({ file, rel: file.name })), { source: 'home', dir: at }, {
    returnFocus: files.value,
    settled: () => {
      for (const f of list) if (!picked.value.includes(f.name)) picked.value.push(f.name);
      if (at === dir.value) void listZips();
    },
  });
  files.value!.value = '';
}

async function start() {
  busy.value = true; alert.value = '';
  try {
    const created = await api.post<TransferJob>('/api/v1/imports',
      { archives: picked.value.map((n) => join(dir.value, n)), dir: dir.value, onCollision: 'keep-both' });
    transfers.apply(created);
    jobId.value = created.id;
  } catch (e) { report(e); } // handled: shown in the alert line
  finally { busy.value = false; }
}

const statusText = computed(() => {
  const j = job.value;
  if (!j) return '';
  if (j.status === 'running') return t('archiveImport.running', { done: j.done, total: j.total });
  return t(`archiveImport.${j.status}`, { count: j.verifiedFiles });
});
const shortPath = (p: string) => p.slice(p.lastIndexOf('/', p.indexOf('.zip/') >= 0 ? p.indexOf('.zip/') : p.length) + 1);
</script>

<template>
  <section class="page page-narrow migrate">
    <div class="toolbar">
      <h1 class="view-title">
        {{ t('archiveImport.title') }}
      </h1>
    </div>
    <p class="trash-note">
      {{ t('archiveImport.intro') }}
    </p>
    <p class="trash-note">
      {{ t('archiveImport.photos') }}
    </p>
    <p
      v-if="alert"
      role="alert"
    >
      {{ alert }}
    </p>
    <FolderPicker
      v-model="dir"
      source="home"
      :root-label="t('nav.home')"
      :label="t('archiveImport.target')"
    />
    <label
      class="fs-label"
      for="import-upload"
    >{{ t('archiveImport.upload') }}</label>
    <input
      id="import-upload"
      ref="files"
      type="file"
      accept=".zip,application/zip"
      multiple
      @change="upload()"
    >
    <fieldset class="migrate-accounts">
      <legend class="fs-label">
        {{ t('archiveImport.archives') }}
      </legend>
      <p
        v-if="zips.length === 0"
        class="trash-note"
      >
        {{ t('archiveImport.none') }}
      </p>
      <label
        v-for="z in zips"
        :key="z"
        class="migrate-radio"
      >
        <input
          v-model="picked"
          type="checkbox"
          :value="z"
        >
        {{ z }}
      </label>
    </fieldset>
    <div class="migrate-actions">
      <button
        type="button"
        class="button primary"
        :disabled="busy || picked.length === 0 || job?.status === 'running'"
        @click="start()"
      >
        {{ t('archiveImport.start') }}
      </button>
    </div>
    <p
      class="status"
      role="status"
      aria-live="polite"
    >
      {{ statusText }}
    </p>
    <template v-if="job && job.status !== 'running'">
      <RouterLink :to="folderRoute('home', job.dir)">
        {{ t('archiveImport.open') }}
      </RouterLink>
      <template v-if="job.skipped.length">
        <h2 class="migrate-step">
          {{ t('archiveImport.skippedTitle') }}
        </h2>
        <ul data-testid="import-skipped">
          <li
            v-for="s in job.skipped"
            :key="s.path"
          >
            {{ shortPath(s.path) }} · {{ t(`archiveImport.reason.${s.reason}`) }}
          </li>
        </ul>
      </template>
      <template v-if="job.failed.length">
        <h2 class="migrate-step">
          {{ t('archiveImport.failedTitle') }}
        </h2>
        <ul data-testid="import-failed">
          <li
            v-for="f in job.failed"
            :key="f.path"
          >
            {{ shortPath(f.path) }} · {{ t(`errors.${f.code}`) }}
          </li>
        </ul>
      </template>
    </template>
  </section>
</template>
