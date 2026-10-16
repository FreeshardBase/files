<script setup lang="ts">
// The transfer panel (spec §3.8, #152): one row per copy or move between sources, live from the server's event stream,
// with its progress, cancel while it runs, and the items that failed once it has ended; migrations and their cleanups
// (#153) link to their page. It uses the upload panel's sheet
// (DESIGN.md), so both read as one kind of thing.
import { useI18n } from 'vue-i18n';
import type { TransferJob } from '@files/shared';
import { useTransfersStore } from '../stores/transfers.ts';
import { useConnectionsStore } from '../stores/connections.ts';
import { formatSize, intlLocale } from '../format.ts';

const transfers = useTransfersStore();
const connections = useConnectionsStore();
const { t, locale } = useI18n();

// Never rounded up (#242): a running job reads 99 % at most.
const percent = (j: TransferJob) => (j.status !== 'running' || j.total === 0 ? 100
  : Math.min(99, Math.floor(((j.done + j.failed.length + j.cancelled) / j.total) * 100)));
const sourceName = (source: string) => {
  if (source === 'home') return t('nav.home');
  const c = connections.bySource(source);
  return c ? t('nav.connection', { provider: c.providerName, account: c.account }) : t('nav.shared');
};
const target = (j: TransferJob) => (j.dir === '/' ? sourceName(j.to) : `${sourceName(j.to)}${j.dir}`);
// A migration and its cleanup (#153) link to the migration's page, with the summary and the cleanup.
const migrationOf = (j: TransferJob) => (j.kind === 'migration' ? j.id : j.kind === 'cleanup' ? j.origin : null);
const stateText = (j: TransferJob) => {
  if (j.status === 'running') return t('transfers.state.running', { done: j.done, total: j.total, size: formatSize(j.bytes, intlLocale(locale.value)) });
  if (j.status === 'completed_with_errors') return t('transfers.state.completed_with_errors', { failed: j.failed.length, total: j.total });
  return t(`transfers.state.${j.status}`);
};
</script>

<template>
  <section
    v-if="transfers.jobs.length"
    class="upload-panel transfer-panel"
    :aria-label="t('transfers.panelTitle')"
    data-testid="transfer-panel"
  >
    <div class="upload-panel-head">
      <h2 class="fs-label">
        {{ t('transfers.panelTitle') }}
      </h2>
      <button
        v-if="transfers.finished"
        type="button"
        class="button"
        @click="transfers.clearFinished()"
      >
        {{ t('transfers.clear') }}
      </button>
    </div>
    <ul class="upload-items">
      <li
        v-for="j in transfers.jobs"
        :key="j.id"
        class="upload-item"
        :data-state="j.status === 'completed_with_errors' ? 'failed' : j.status"
      >
        <span class="upload-name">{{ t(`transfers.label.${j.kind === 'transfer' ? j.mode : j.kind}`, { name: j.name, target: target(j) }) }}</span>
        <span
          class="upload-state"
          :class="{ 'value-mono': j.status === 'running' }"
        >{{ stateText(j) }}</span>
        <div
          class="upload-bar"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="percent(j)"
          :aria-label="t('transfers.progressLabel', { name: j.name })"
        >
          <span :style="{ width: `${percent(j)}%` }" />
        </div>
        <span class="upload-actions">
          <RouterLink
            v-if="migrationOf(j)"
            class="button"
            :to="`/migrate/${migrationOf(j)}`"
            :aria-label="t('transfers.summaryLabel', { name: j.name })"
          >
            {{ t('transfers.summary') }}
          </RouterLink>
          <button
            v-if="j.status === 'running'"
            type="button"
            class="button danger"
            :aria-label="t('transfers.cancelLabel', { name: j.name })"
            @click="transfers.cancel(j.id)"
          >
            {{ t('transfers.cancel') }}
          </button>
        </span>
        <ul
          v-if="j.failed.length"
          class="transfer-failures"
        >
          <li
            v-for="f in j.failed"
            :key="f.path"
          >
            {{ t('transfers.failedItem', { path: f.path, reason: t(`errors.${f.code}`) }) }}
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>
