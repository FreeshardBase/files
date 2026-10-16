<script setup lang="ts">
// What the member recently uploaded, copied, moved, renamed or restored, newest first, each with a way to its folder.
// Only the member's own writes; there is no feed of other members' actions.
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { RecentItem } from '@files/shared';
import { useRecentStore } from '../stores/recent.ts';
import { folderRoute } from '../api/paths.ts';
import { formatDate, intlLocale } from '../format.ts';

const { t, locale } = useI18n();
const recent = useRecentStore();
onMounted(() => { void recent.load(); });

const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const folderLabel = (p: string) => p === '/' ? t('nav.home') : p;
// A folder opens itself; a file opens the folder it is in.
const target = (item: RecentItem) => folderRoute(item.source, item.type === 'directory' ? item.path : parentOf(item.path));
</script>

<template>
  <section class="page recent">
    <div class="toolbar">
      <h1
        class="view-title"
        tabindex="-1"
      >
        {{ $t('recent.title') }}
      </h1>
    </div>
    <p v-if="!recent.loaded">
      {{ $t('folder.loading') }}
    </p>
    <p
      v-else-if="recent.error"
      role="alert"
    >
      {{ $t(`errors.${recent.error.code}`) }}
    </p>
    <p
      v-else-if="recent.items.length === 0"
      class="recent-empty"
    >
      {{ $t('recent.empty') }}
    </p>
    <table
      v-else
      class="file-list trash-list recent-list"
      :aria-label="$t('recent.title')"
    >
      <thead>
        <tr>
          <th scope="col">
            {{ $t('recent.columns.name') }}
          </th>
          <th scope="col">
            {{ $t('recent.columns.location') }}
          </th>
          <th scope="col">
            {{ $t('recent.columns.changed') }}
          </th>
          <th scope="col">
            <span class="visually-hidden">{{ $t('recent.columns.actions') }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="item in recent.items"
          :key="`${item.source}:${item.path}`"
          :data-type="item.type"
        >
          <td class="name">
            <div class="name-inner">
              <span
                class="icon"
                :class="item.type === 'directory' ? 'icon-folder' : 'icon-file'"
                aria-hidden="true"
              />
              <span
                class="name-text"
                :title="item.name"
              >{{ item.name }}</span>
            </div>
          </td>
          <td class="origin">
            <span
              class="origin-text"
              :title="folderLabel(parentOf(item.path))"
            >{{ folderLabel(parentOf(item.path)) }}</span>
          </td>
          <td class="num date">
            {{ formatDate(item.changedAt, intlLocale(locale)) }}
          </td>
          <td class="actions">
            <RouterLink
              class="button"
              :to="target(item)"
              :aria-label="item.type === 'directory' ? $t('recent.openLabel', { name: item.name })
                : $t('recent.openFolderLabel', { name: item.name })"
            >
              {{ $t('recent.openFolder') }}
            </RouterLink>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
