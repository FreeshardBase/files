<script setup lang="ts">
// What the member recently uploaded, copied, moved, renamed or restored, newest first, each with a way to its folder.
// Only the member's own writes; there is no feed of other members' actions.
import { onMounted, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import type { RecentItem } from '@files/shared';
import { useRecentStore } from '../stores/recent.ts';
import { folderRoute } from '../api/paths.ts';
import { formatDate, intlLocale } from '../format.ts';
import { parentOf, useLocations } from '../location.ts';
import { hasThumbnail, pageThumb, thumbnailHref } from '../preview.ts';
import RowSkeleton from '../components/RowSkeleton.vue';

const { locale } = useI18n();
const recent = useRecentStore();
const { folderLabel } = useLocations();
onMounted(() => { void recent.load(); });
// A thumbnail in the folder list's 28 px slot (#244); one that fails to load falls back to the line icon.
const thumbFailed = reactive(new Set<string>());
// A folder opens itself; a file opens the folder it is in with the file selected (#235), as from Favourites.
const target = (item: RecentItem) => item.type === 'directory' ? folderRoute(item.source, item.path)
  : { path: folderRoute(item.source, parentOf(item.path)), query: { select: item.path } };
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
    <RowSkeleton v-if="!recent.loaded" />
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
              <img
                v-if="hasThumbnail(item) && !thumbFailed.has(item.path)"
                class="row-thumb"
                :data-page="pageThumb(item)"
                :src="thumbnailHref(item.source, { path: item.path, modified: item.changedAt }, 128)"
                alt=""
                loading="lazy"
                @error="thumbFailed.add(item.path)"
              >
              <span
                v-else
                class="icon"
                :class="item.type === 'directory' ? 'icon-folder' : 'icon-file'"
                aria-hidden="true"
              />
              <RouterLink :to="target(item)">
                <span
                  class="name-text"
                  :title="item.name"
                >{{ item.name }}</span>
              </RouterLink>
            </div>
          </td>
          <td class="origin">
            <span
              class="origin-text"
              :title="folderLabel(item.source, parentOf(item.path))"
            >{{ folderLabel(item.source, parentOf(item.path)) }}</span>
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
