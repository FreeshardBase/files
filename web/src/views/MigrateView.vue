<script setup lang="ts">
// "Move to shard" (#153): the migration wizard. 1. a connection and its folder (its root is the whole account), 2. the
// home folder and the name of the new folder, 3. the server's scan of what will be copied, then the start. The job's own
// page (MigrationJobView) follows its progress, the summary and the cleanup.
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { Connection, MigrationScan, TransferJob } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { useConnectionsStore } from '../stores/connections.ts';
import { useTransfersStore } from '../stores/transfers.ts';
import { formatSize, intlLocale } from '../format.ts';
import FolderPicker from '../components/FolderPicker.vue';

const { t, locale } = useI18n();
const router = useRouter();
const connections = useConnectionsStore();
const transfers = useTransfersStore();

const step = ref<1 | 2 | 3>(1);
const source = ref('');
const from = ref('/');
const dir = ref('/');
const name = ref('');
const scan = ref<MigrationScan | null>(null);
const alert = ref('');
const busy = ref(false);
const stepHeading = ref<HTMLElement>();

const usable = computed(() => connections.items.filter((c) => c.status === 'ok'));
const conn = computed<Connection | undefined>(() => connections.bySource(source.value));
const account = computed(() => (conn.value ? t('nav.connection', { provider: conn.value.providerName, account: conn.value.account }) : ''));
const fromLabel = computed(() => (from.value === '/' ? t('migrate.wholeAccount', { account: account.value }) : `${account.value}${from.value}`));
const toLabel = computed(() => `${t('nav.home')}${dir.value === '/' ? '' : dir.value}/${name.value.trim()}`);
const nameValid = computed(() => { const n = name.value.trim(); return n !== '' && n !== '.' && n !== '..' && !n.includes('/'); });
const size = (n: number) => formatSize(n, intlLocale(locale.value));

onMounted(async () => {
  if (!connections.loaded) await connections.load();
  source.value = usable.value[0]?.source ?? '';
});
// Another account starts at its root again.
watch(source, () => { from.value = '/'; });

const report = (e: unknown) => {
  if (!(e instanceof ApiFailure)) throw e;
  alert.value = t(`errors.${e.code}`);
};

async function go(to: 1 | 2 | 3) {
  alert.value = '';
  step.value = to;
  await nextTick();
  stepHeading.value?.focus();
}

async function toTarget() {
  // The new folder is named after what is moved; the member can change it.
  name.value = from.value === '/' ? (conn.value ? `${conn.value.providerName} ${conn.value.account}`.replace(/\//g, '-') : '')
    : from.value.slice(from.value.lastIndexOf('/') + 1);
  await go(2);
}

async function toReview() {
  scan.value = null;
  await go(3);
  try { scan.value = await api.get<MigrationScan>('/api/v1/migrations/scan', { source: source.value, path: from.value }); }
  catch (e) { report(e); } // handled: shown in the alert line; the member can go back or start anyway
}

async function start() {
  busy.value = true; alert.value = '';
  try {
    const job = await api.post<TransferJob>('/api/v1/migrations', { from: source.value, path: from.value, dir: dir.value, name: name.value.trim() });
    transfers.apply(job);
    await router.push(`/migrate/${job.id}`);
  } catch (e) { report(e); } // handled: shown in the alert line
  finally { busy.value = false; }
}
</script>

<template>
  <section class="page page-narrow migrate">
    <div class="toolbar">
      <h1 class="view-title">
        {{ t('migrate.title') }}
      </h1>
    </div>
    <p class="trash-note">
      {{ t('migrate.intro') }}
    </p>
    <p>
      <RouterLink to="/import">
        {{ t('archiveImport.link') }}
      </RouterLink>
    </p>
    <p
      v-if="alert"
      role="alert"
    >
      {{ alert }}
    </p>
    <p v-if="!connections.loaded">
      {{ t('folder.loading') }}
    </p>
    <p
      v-else-if="usable.length === 0"
      class="recent-empty"
    >
      {{ t('migrate.noConnections') }}
      <RouterLink to="/connections">
        {{ t('nav.connections') }}
      </RouterLink>
    </p>
    <template v-else-if="step === 1">
      <h2
        ref="stepHeading"
        class="migrate-step"
        tabindex="-1"
      >
        {{ t('migrate.steps.source') }}
      </h2>
      <fieldset class="migrate-accounts">
        <legend class="fs-label">
          {{ t('migrate.account') }}
        </legend>
        <label
          v-for="c in usable"
          :key="c.id"
          class="migrate-radio"
        >
          <input
            v-model="source"
            type="radio"
            name="migrate-source"
            :value="c.source"
          >
          {{ t('nav.connection', { provider: c.providerName, account: c.account }) }}
        </label>
      </fieldset>
      <FolderPicker
        v-if="source"
        v-model="from"
        :source="source"
        :root-label="account"
        :label="t('migrate.cloudFolders')"
      />
      <p class="migrate-choice">
        {{ t('migrate.chosenSource', { what: fromLabel }) }}
      </p>
      <div class="migrate-actions">
        <button
          type="button"
          class="button primary"
          @click="toTarget()"
        >
          {{ t('migrate.next') }}
        </button>
      </div>
    </template>
    <template v-else-if="step === 2">
      <h2
        ref="stepHeading"
        class="migrate-step"
        tabindex="-1"
      >
        {{ t('migrate.steps.target') }}
      </h2>
      <FolderPicker
        v-model="dir"
        source="home"
        :root-label="t('nav.home')"
        :label="t('migrate.shardFolders')"
      />
      <label
        class="fs-label"
        for="migrate-name"
      >{{ t('migrate.name') }}</label>
      <input
        id="migrate-name"
        v-model="name"
        class="fs-input migrate-name"
        type="text"
        maxlength="255"
        :aria-invalid="!nameValid"
        aria-describedby="migrate-name-note"
      >
      <p
        id="migrate-name-note"
        class="trash-note"
      >
        {{ t('migrate.nameNote') }}
      </p>
      <p class="migrate-choice">
        {{ t('migrate.chosenTarget', { where: toLabel }) }}
      </p>
      <div class="migrate-actions">
        <button
          type="button"
          class="button"
          @click="go(1)"
        >
          {{ t('migrate.back') }}
        </button>
        <button
          type="button"
          class="button primary"
          :disabled="!nameValid"
          @click="toReview()"
        >
          {{ t('migrate.next') }}
        </button>
      </div>
    </template>
    <template v-else>
      <h2
        ref="stepHeading"
        class="migrate-step"
        tabindex="-1"
      >
        {{ t('migrate.steps.review') }}
      </h2>
      <dl class="details-facts">
        <dt>{{ t('migrate.from') }}</dt>
        <dd>{{ fromLabel }}</dd>
        <dt>{{ t('migrate.to') }}</dt>
        <dd>{{ toLabel }}</dd>
        <template v-if="scan">
          <dt>{{ t('migrate.files') }}</dt>
          <dd data-testid="scan-files">
            {{ scan.files }}
          </dd>
          <dt>{{ t('migrate.folders') }}</dt>
          <dd>{{ scan.folders }}</dd>
          <dt>{{ t('migrate.size') }}</dt>
          <dd>{{ size(scan.bytes) }}</dd>
        </template>
      </dl>
      <p
        class="status"
        role="status"
        aria-live="polite"
      >
        {{ !scan && !alert ? t('migrate.counting') : scan && !scan.complete ? t('migrate.atLeast') : '' }}
      </p>
      <div class="migrate-actions">
        <button
          type="button"
          class="button"
          @click="go(2)"
        >
          {{ t('migrate.back') }}
        </button>
        <button
          type="button"
          class="button primary"
          :disabled="busy || (!scan && !alert)"
          @click="start()"
        >
          {{ t('migrate.start') }}
        </button>
      </div>
    </template>
  </section>
</template>
