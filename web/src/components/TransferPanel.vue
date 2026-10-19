<script setup lang="ts">
// The transfer panel (spec §3.8, #152): one row per copy or move between sources, live from the server's event stream,
// with its progress, cancel while it runs, and the items that failed once it has ended; migrations and their cleanups
// (#153) link to their page, an import to the import page (#354). It uses the upload panel's sheet
// (DESIGN.md), so both read as one kind of thing. A job of several items is labelled by their count, with the names in a
// disclosure (#234). An ended job shows in full for a few seconds once seen, then a successful one leaves and any other
// folds into one summary line, where it stays until dismissed.
import { computed, onMounted, onUnmounted, ref, watchEffect } from 'vue';
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
// Several picked items are named by their count (#234); their names are in the row's details.
const many = (j: TransferJob) => j.kind === 'transfer' && j.picked > 1;
const title = (j: TransferJob) => (many(j) ? t('transfers.items', { count: j.picked }) : j.name);
const label = (j: TransferJob) => (many(j)
  ? t(`transfers.labelMany.${j.mode}`, { count: j.picked, target: target(j) })
  : t(`transfers.label.${j.kind === 'transfer' ? j.mode : j.kind}`, { name: j.name, target: target(j) }));
// A migration and its cleanup (#153) link to the migration's page, with the summary and the cleanup.
const migrationOf = (j: TransferJob) => (j.kind === 'migration' ? j.id : j.kind === 'cleanup' ? j.origin : null);
// An import (#354) links to the import page, which shows the latest import's report.
const pageOf = (j: TransferJob) => {
  if (j.kind === 'import') return '/import';
  const m = migrationOf(j);
  return m ? `/migrate/${m}` : null;
};
const stateText = (j: TransferJob) => {
  if (j.status === 'running') return t('transfers.state.running', { done: j.done, total: j.total, size: formatSize(j.bytes, intlLocale(locale.value)) });
  if (j.status === 'completed_with_errors') return t('transfers.state.completed_with_errors', { failed: j.failed.length, total: j.total });
  return t(`transfers.state.${j.status}`);
};

// An ended job counts as seen while this page is visible (#234); a tab in the background sees nothing.
const visible = ref(document.visibilityState === 'visible');
const onVisibility = () => { visible.value = document.visibilityState === 'visible'; };
onMounted(() => document.addEventListener('visibilitychange', onVisibility));
onUnmounted(() => document.removeEventListener('visibilitychange', onVisibility));
watchEffect(() => {
  if (!visible.value) return;
  for (const j of transfers.jobs) if (j.status !== 'running') transfers.seen(j.id);
});
const shown = computed(() => transfers.jobs.filter((j) => !transfers.folded.includes(j.id)));
const folded = computed(() => transfers.jobs.filter((j) => transfers.folded.includes(j.id)));
const foldedText = computed(() => {
  const failed = folded.value.filter((j) => j.status === 'completed_with_errors').length;
  return [t('transfers.folded', { count: folded.value.length }, folded.value.length),
    ...(failed ? [t('transfers.foldedFailed', { count: failed }, failed)] : [])].join(' · ');
});
const unfolded = ref(false);
const rows = computed(() => (unfolded.value ? [...shown.value, ...folded.value] : shown.value));
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
    <p
      v-if="folded.length"
      class="transfer-folded"
    >
      <span>{{ foldedText }}</span>
      <button
        type="button"
        class="button"
        :aria-expanded="unfolded ? 'true' : 'false'"
        @click="unfolded = !unfolded"
      >
        {{ unfolded ? t('transfers.hide') : t('transfers.show') }}
      </button>
    </p>
    <ul
      v-if="rows.length"
      class="upload-items"
    >
      <li
        v-for="j in rows"
        :key="j.id"
        class="upload-item"
        :data-state="j.status === 'completed_with_errors' ? 'failed' : j.status"
      >
        <span class="upload-name">{{ label(j) }}</span>
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
          :aria-label="t('transfers.progressLabel', { name: title(j) })"
        >
          <span :style="{ width: `${percent(j)}%` }" />
        </div>
        <span class="upload-actions">
          <RouterLink
            v-if="pageOf(j)"
            class="button"
            :to="pageOf(j)!"
            :aria-label="t('transfers.summaryLabel', { name: j.name })"
          >
            {{ t('transfers.summary') }}
          </RouterLink>
          <button
            v-if="j.status === 'running'"
            type="button"
            class="button danger"
            :aria-label="t('transfers.cancelLabel', { name: title(j) })"
            @click="transfers.cancel(j.id)"
          >
            {{ t('transfers.cancel') }}
          </button>
          <button
            v-else
            type="button"
            class="button"
            :aria-label="t('transfers.dismissLabel', { name: title(j) })"
            @click="transfers.dismiss(j.id)"
          >
            {{ t('transfers.dismiss') }}
          </button>
        </span>
        <details
          v-if="many(j)"
          class="transfer-names"
        >
          <summary>{{ t('transfers.names') }}</summary>
          <ul>
            <li
              v-for="(n, i) in j.names"
              :key="i"
            >
              {{ n }}
            </li>
            <li v-if="j.picked > j.names.length">
              {{ t('transfers.moreNames', { count: j.picked - j.names.length }) }}
            </li>
          </ul>
        </details>
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
