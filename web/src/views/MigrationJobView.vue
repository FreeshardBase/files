<script setup lang="ts">
// One migration's page (#153): its progress while it runs (live from the transfers store's event stream), then the
// summary with every failure and the CSV export, then "Delete verified originals": the server's preview fills the
// confirmation in an <AppDialog>, and only its confirm button sends the single-use token. The cleanup is a job of its
// own, shown underneath with its result.
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { CleanupPreview, TransferJob } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { useTransfersStore } from '../stores/transfers.ts';
import { useConnectionsStore } from '../stores/connections.ts';
import { formatSize, intlLocale } from '../format.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';

const { t, locale } = useI18n();
const route = useRoute();
const transfers = useTransfersStore();
const connections = useConnectionsStore();

const id = computed(() => String(route.params.id));
const job = computed(() => transfers.jobs.find((j) => j.id === id.value && j.kind === 'migration'));
const cleanup = computed(() => transfers.jobs.find((j) => j.kind === 'cleanup' && j.origin === id.value));
const alert = ref('');
const loadFailed = ref(false);
const preview = ref<CleanupPreview | null>(null);
const busy = ref(false);

const size = (n: number) => formatSize(n, intlLocale(locale.value));
const account = computed(() => {
  const c = job.value ? connections.bySource(job.value.from) : undefined;
  return c ? t('nav.connection', { provider: c.providerName, account: c.account }) : t('migrate.theCloud');
});
// Never rounded up (#242): a running job reads 99 % at most.
const percent = (j: TransferJob) => (j.status !== 'running' || j.total === 0 ? 100
  : Math.min(99, Math.floor(((j.done + j.failed.length + j.cancelled) / j.total) * 100)));
// A migration counts files, like its scan; until every folder is listed its total is not known yet (#227).
const state = (j: TransferJob) => (j.status === 'running'
  ? j.kind === 'migration'
    ? j.listing ? t('migrate.counting') : t('migrate.running', { done: j.verifiedFiles, total: j.files, size: size(j.bytes) })
    : t('transfers.state.running', { done: j.done, total: j.total, size: size(j.bytes) })
  : j.status === 'completed_with_errors' ? t('transfers.state.completed_with_errors', { failed: j.failed.length, total: j.total })
    : t(`transfers.state.${j.status}`));
// The heading follows the job: moving, moved, or cancelled (#227).
const heading = (j: TransferJob) => t(j.status === 'running' ? 'migrate.jobTitle'
  : j.status === 'cancelled' ? 'migrate.jobTitleCancelled' : 'migrate.jobTitleDone', { name: j.name });
const reportHref = (j: TransferJob) => `/api/v1/transfers/${encodeURIComponent(j.id)}/report`;

const report = (e: unknown) => {
  if (!(e instanceof ApiFailure)) throw e;
  alert.value = t(`errors.${e.code}`);
};

onMounted(async () => {
  if (!connections.loaded) void connections.load();
  if (job.value) return;
  // Opened directly (a reload, a link): the job comes from the server until the event stream has it.
  try { transfers.apply(await api.get<TransferJob>(`/api/v1/transfers/${encodeURIComponent(id.value)}`)); }
  catch (e) { loadFailed.value = true; report(e); } // handled: shown in the alert line instead of the page
});

async function askCleanup() {
  alert.value = '';
  try { preview.value = await api.get<CleanupPreview>(`/api/v1/migrations/${encodeURIComponent(id.value)}/cleanup`); }
  catch (e) { report(e); } // handled: shown in the alert line
}

async function confirmCleanup() {
  const token = preview.value!.token;
  preview.value = null;
  busy.value = true;
  try { transfers.apply(await api.post<TransferJob>(`/api/v1/migrations/${encodeURIComponent(id.value)}/cleanup`, { token })); }
  catch (e) { report(e); } // handled: shown in the alert line
  finally { busy.value = false; }
}
</script>

<template>
  <section class="page page-narrow migrate">
    <div class="toolbar">
      <h1 class="view-title">
        {{ job ? heading(job) : t('migrate.title') }}
      </h1>
      <RouterLink
        class="button"
        to="/migrate"
      >
        {{ t('migrate.another') }}
      </RouterLink>
    </div>
    <p
      v-if="alert"
      role="alert"
    >
      {{ alert }}
    </p>
    <p v-if="!job && !loadFailed">
      {{ t('folder.loading') }}
    </p>
    <template v-if="job">
      <dl class="details-facts">
        <dt>{{ t('migrate.from') }}</dt>
        <dd>{{ account }}</dd>
        <dt>{{ t('migrate.to') }}</dt>
        <dd>{{ `${t('nav.home')}${job.dir === '/' ? '' : job.dir}/${job.name}` }}</dd>
        <dt>{{ t('migrate.state') }}</dt>
        <dd
          class="migrate-state"
          :data-state="job.status"
        >
          {{ state(job) }}
        </dd>
      </dl>
      <div
        class="upload-bar"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="percent(job)"
        :aria-label="t('migrate.progressLabel', { name: job.name })"
      >
        <span :style="{ width: `${percent(job)}%` }" />
      </div>

      <section
        v-if="job.status !== 'running'"
        class="migrate-summary"
        :aria-label="t('migrate.summary.title')"
      >
        <h2 class="migrate-step">
          {{ t('migrate.summary.title') }}
        </h2>
        <dl class="details-facts">
          <dt>{{ t('migrate.summary.verified') }}</dt>
          <dd data-testid="verified-files">
            {{ job.verifiedFiles }}
          </dd>
          <dt>{{ t('migrate.size') }}</dt>
          <dd>{{ size(job.bytes) }}</dd>
          <dt>{{ t('migrate.summary.failed') }}</dt>
          <dd>{{ job.failed.length }}</dd>
        </dl>
        <p
          v-if="job.status === 'cancelled'"
          class="trash-note"
        >
          {{ t('migrate.summary.cancelled') }}
        </p>
        <ul
          v-if="job.failed.length"
          class="transfer-failures migrate-failures"
          :aria-label="t('migrate.summary.failedList')"
        >
          <li
            v-for="f in job.failed"
            :key="f.path"
          >
            {{ t('transfers.failedItem', { path: f.path, reason: t(`errors.${f.code}`) }) }}
          </li>
        </ul>
        <div class="migrate-actions">
          <a
            class="button"
            :href="reportHref(job)"
            download
          >{{ t('migrate.summary.export') }}</a>
        </div>

        <h2 class="migrate-step">
          {{ t('migrate.cleanup.title') }}
        </h2>
        <template v-if="!cleanup">
          <p class="trash-note">
            {{ t('migrate.cleanup.intro', { account }) }}
          </p>
          <p
            v-if="job.verifiedFiles === 0"
            class="trash-note"
          >
            {{ t('migrate.cleanup.nothing') }}
          </p>
          <div
            v-else
            class="migrate-actions"
          >
            <button
              type="button"
              class="button danger"
              :disabled="busy"
              @click="askCleanup()"
            >
              {{ t('migrate.cleanup.start') }}
            </button>
          </div>
        </template>
        <section
          v-else
          class="migrate-cleanup"
          :aria-label="t('migrate.cleanup.title')"
        >
          <dl class="details-facts">
            <dt>{{ t('migrate.state') }}</dt>
            <dd
              class="migrate-state"
              :data-state="cleanup.status"
            >
              {{ state(cleanup) }}
            </dd>
            <dt>{{ t('migrate.cleanup.deleted') }}</dt>
            <dd data-testid="deleted-files">
              {{ cleanup.verifiedFiles }}
            </dd>
            <dt>{{ t('migrate.cleanup.kept') }}</dt>
            <dd>{{ cleanup.failed.length }}</dd>
          </dl>
          <div
            class="upload-bar"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="percent(cleanup)"
            :aria-label="t('migrate.cleanup.progressLabel', { name: job.name })"
          >
            <span :style="{ width: `${percent(cleanup)}%` }" />
          </div>
          <ul
            v-if="cleanup.failed.length"
            class="transfer-failures migrate-failures"
          >
            <li
              v-for="f in cleanup.failed"
              :key="f.path"
            >
              {{ t('transfers.failedItem', { path: f.path, reason: t(`errors.${f.code}`) }) }}
            </li>
          </ul>
          <div
            v-if="cleanup.status !== 'running'"
            class="migrate-actions"
          >
            <a
              class="button"
              :href="reportHref(cleanup)"
              download
            >{{ t('migrate.summary.export') }}</a>
          </div>
        </section>
      </section>
    </template>
    <ConfirmDialog
      v-if="preview"
      :title="t('migrate.cleanup.confirmTitle')"
      :message="preview.files === 0 ? t('migrate.cleanup.nothing')
        : t('migrate.cleanup.confirmMessage', { count: preview.files, size: size(preview.bytes), account })"
      :confirm-label="t('migrate.cleanup.confirm')"
      @confirm="confirmCleanup()"
      @cancel="preview = null"
    />
  </section>
</template>
