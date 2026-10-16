<script setup lang="ts">
// The storage overview (#156): the member's shard usage against their quota, split into files, trash, versions and
// uploads in progress; each cloud connection's provider quota; and the largest folders of the home.
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ConnectionUsage } from '@files/shared';
import { useStorageStore } from '../stores/storage.ts';
import { useConnectionsStore } from '../stores/connections.ts';
import { folderRoute } from '../api/paths.ts';
import { formatSize, intlLocale } from '../format.ts';
import UsageBar from '../components/UsageBar.vue';

const { t, locale } = useI18n();
const storage = useStorageStore();
const connections = useConnectionsStore();
onMounted(() => { void storage.load(); });

const size = (n: number) => formatSize(n, intlLocale(locale.value));
const home = computed(() => storage.overview?.home);
const shardText = computed(() => {
  const h = home.value!;
  return h.quota === null ? t('storage.usedNoQuota', { used: size(h.usage.total) })
    : t('storage.usedOf', { used: size(h.usage.total), total: size(h.quota) });
});
const parts = ['files', 'trash', 'versions', 'uploads'] as const;
// The sidebar already loaded the connections; a source it does not know yet is named by its id.
const nameOf = (c: ConnectionUsage) => {
  const conn = connections.bySource(c.source);
  return conn ? t('nav.connection', { provider: conn.providerName, account: conn.account }) : c.source;
};
const cloudText = (q: { used: number; total?: number }) => (q.total === undefined
  ? t('storage.cloudUsedNoLimit', { used: size(q.used) }) : t('storage.usedOf', { used: size(q.used), total: size(q.total) }));
</script>

<template>
  <section class="page recent storage">
    <div class="toolbar">
      <h1
        class="view-title"
        tabindex="-1"
      >
        {{ $t('storage.title') }}
      </h1>
    </div>
    <p v-if="!storage.loaded">
      {{ $t('folder.loading') }}
    </p>
    <p
      v-else-if="storage.error"
      role="alert"
    >
      {{ $t(`errors.${storage.error.code}`) }}
    </p>
    <template v-else-if="home && storage.overview">
      <h2 class="storage-heading">
        {{ $t('storage.shard') }}
      </h2>
      <div class="storage-source">
        <p class="storage-figures">
          {{ shardText }}
        </p>
        <UsageBar
          v-if="home.quota !== null"
          :used="home.usage.total"
          :total="home.quota"
          :label="$t('storage.shardBar')"
          :text="shardText"
        />
        <dl
          class="storage-breakdown"
          :aria-label="$t('storage.breakdown')"
        >
          <div
            v-for="p in parts"
            :key="p"
          >
            <dt>{{ $t(`storage.${p}`) }}</dt>
            <dd>{{ size(home.usage[p]) }}</dd>
          </div>
        </dl>
      </div>

      <h2 class="storage-heading">
        {{ $t('storage.clouds') }}
      </h2>
      <p
        v-if="storage.overview.connections.length === 0"
        class="recent-empty"
      >
        {{ $t('storage.noClouds') }}
      </p>
      <ul
        v-else
        class="storage-clouds"
      >
        <li
          v-for="c in storage.overview.connections"
          :key="c.source"
          class="storage-source"
        >
          <span class="storage-name">{{ nameOf(c) }}</span>
          <template v-if="c.quota">
            <p class="storage-figures">
              {{ cloudText(c.quota) }}
            </p>
            <UsageBar
              v-if="c.quota.total !== undefined"
              :used="c.quota.used"
              :total="c.quota.total"
              :label="$t('storage.cloudBar', { name: nameOf(c) })"
              :text="cloudText(c.quota)"
            />
          </template>
          <p
            v-else-if="c.quota === null"
            class="storage-figures"
          >
            {{ $t('storage.cloudUnknown') }}
          </p>
          <p
            v-else-if="c.error"
            class="storage-error"
          >
            {{ $t(`errors.${c.error.code}`) }}
          </p>
        </li>
      </ul>

      <h2 class="storage-heading">
        {{ $t('storage.largest') }}
      </h2>
      <p
        v-if="home.largest.length === 0"
        class="recent-empty"
      >
        {{ $t('storage.noFolders') }}
      </p>
      <table
        v-else
        class="file-list trash-list storage-largest"
        :aria-label="$t('storage.largest')"
      >
        <thead>
          <tr>
            <th scope="col">
              {{ $t('storage.columns.folder') }}
            </th>
            <th scope="col">
              {{ $t('storage.columns.size') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="f in home.largest"
            :key="f.path"
          >
            <td class="name">
              <div class="name-inner">
                <span
                  class="icon icon-folder"
                  aria-hidden="true"
                />
                <RouterLink
                  :to="folderRoute('home', f.path)"
                  :aria-label="$t('storage.openLabel', { path: f.path })"
                >
                  {{ f.path }}
                </RouterLink>
              </div>
            </td>
            <td class="num size">
              {{ size(f.size) }}
            </td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>
