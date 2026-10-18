<script setup lang="ts">
// The storage overview (#156): the member's shard usage against their quota, split into files, trash, versions and
// uploads in progress; for the admin the shard's disk with its reserve (#320); each cloud connection's provider quota;
// and the largest folders of the home. The figures (sizes) are set in the mono face, inside the sentences too (#317);
// the sentences as plain text stay the usage bars' value text.
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ConnectionUsage } from '@files/shared';
import { useDiskStore, useStorageStore } from '../stores/storage.ts';
import { useSessionStore } from '../stores/session.ts';
import { useConnectionsStore } from '../stores/connections.ts';
import { folderRoute } from '../api/paths.ts';
import { formatSize, intlLocale } from '../format.ts';
import UsageBar from '../components/UsageBar.vue';
import { useLocations } from '../location.ts';

const { t, locale } = useI18n();
const storage = useStorageStore();
const { folderLabel } = useLocations();
const connections = useConnectionsStore();
const session = useSessionStore();
// The shard's disk and its reserve (#320) are the admin's: the server refuses them to everyone else.
const disk = useDiskStore();
const isAdmin = computed(() => session.me?.role === 'admin');
onMounted(() => { void storage.load(); if (isAdmin.value) void disk.load(); });

const size = (n: number) => formatSize(n, intlLocale(locale.value));
const diskText = computed(() => {
  const d = disk.status!;
  return t('storage.disk.usedOf', { used: size(d.total - d.free), total: size(d.total), free: size(d.free) });
});
const reserveText = computed(() => {
  const d = disk.status!;
  return d.setting === null ? t('storage.disk.reserveDefault', { reserve: size(d.reserve) })
    : t('storage.disk.reserveSet', { reserve: size(d.reserve), setting: d.setting });
});
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
        <i18n-t
          :keypath="home.quota === null ? 'storage.usedNoQuota' : 'storage.usedOf'"
          tag="p"
          class="storage-figures"
          scope="global"
        >
          <template #used>
            <span class="value-mono">{{ size(home.usage.total) }}</span>
          </template>
          <template #total>
            <span
              v-if="home.quota !== null"
              class="value-mono"
            >{{ size(home.quota) }}</span>
          </template>
        </i18n-t>
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
            <dd class="value-mono">
              {{ size(home.usage[p]) }}
            </dd>
          </div>
        </dl>
      </div>

      <template v-if="isAdmin && (disk.status || disk.error)">
        <h2 class="storage-heading">
          {{ $t('storage.disk.title') }}
        </h2>
        <p
          v-if="disk.error"
          class="storage-error"
        >
          {{ $t(`errors.${disk.error.code}`) }}
        </p>
        <div
          v-else-if="disk.status"
          class="storage-source storage-disk"
        >
          <i18n-t
            keypath="storage.disk.usedOf"
            tag="p"
            class="storage-figures"
            scope="global"
          >
            <template #used>
              <span class="value-mono">{{ size(disk.status.total - disk.status.free) }}</span>
            </template>
            <template #total>
              <span class="value-mono">{{ size(disk.status.total) }}</span>
            </template>
            <template #free>
              <span class="value-mono">{{ size(disk.status.free) }}</span>
            </template>
          </i18n-t>
          <UsageBar
            :used="disk.status.total - disk.status.free"
            :total="disk.status.total"
            :label="$t('storage.disk.bar')"
            :text="diskText"
          />
          <p class="storage-reserve">
            {{ reserveText }}
          </p>
          <div
            v-if="disk.status.warning"
            class="alert-banner"
          >
            <p class="alert-title">
              {{ $t('storage.disk.warningTitle') }}
            </p>
            <p class="alert-text">
              {{ $t('storage.disk.warningText') }}
            </p>
          </div>
        </div>
      </template>

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
            <i18n-t
              :keypath="c.quota.total === undefined ? 'storage.cloudUsedNoLimit' : 'storage.usedOf'"
              tag="p"
              class="storage-figures"
              scope="global"
            >
              <template #used>
                <span class="value-mono">{{ size(c.quota.used) }}</span>
              </template>
              <template #total>
                <span
                  v-if="c.quota.total !== undefined"
                  class="value-mono"
                >{{ size(c.quota.total) }}</span>
              </template>
            </i18n-t>
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
                  :aria-label="$t('storage.openLabel', { path: folderLabel('home', f.path) })"
                >
                  {{ folderLabel('home', f.path) }}
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
