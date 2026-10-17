<script setup lang="ts">
// The member's favourites (#155) across their sources, in the order they were starred. A folder opens itself, a file
// opens its folder with the file selected. A favourite whose source is gone (an unlinked connection, a revoked share) is
// shown as unavailable and can only be removed.
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Favourite } from '@files/shared';
import { useFavouritesStore } from '../stores/favourites.ts';
import { ApiFailure } from '../api/client.ts';
import { folderRoute } from '../api/paths.ts';
import { parentOf, useLocations } from '../location.ts';
import { hasThumbnail, thumbnailHref } from '../preview.ts';
import RowSkeleton from '../components/RowSkeleton.vue';

const { t } = useI18n();
const favourites = useFavouritesStore();
const { folderLabel } = useLocations();
const status = ref('');
const failure = ref('');
const title = ref<HTMLElement>();
onMounted(() => { void favourites.load(); });
// A thumbnail in the folder list's 28 px slot (#244), only while the source is there; a failed one shows the line icon.
const thumbFailed = reactive(new Set<number>());

const location = (f: Favourite) => folderLabel(f.source, parentOf(f.path));
const target = (f: Favourite) => f.type === 'directory' ? folderRoute(f.source, f.path)
  : { path: folderRoute(f.source, parentOf(f.path)), query: { select: f.path } };

async function remove(f: Favourite) {
  failure.value = '';
  try {
    await favourites.remove(f.id);
    status.value = t('favourites.removed', { name: f.name });
    title.value?.focus(); // the row and its button are gone

  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    failure.value = t(`errors.${e.code}`);
  }
}
</script>

<template>
  <section class="page favourites">
    <div class="toolbar">
      <h1
        ref="title"
        class="view-title"
        tabindex="-1"
      >
        {{ $t('favourites.title') }}
      </h1>
    </div>
    <p
      class="status"
      role="status"
      aria-live="polite"
    >
      {{ status }}
    </p>
    <p
      v-if="failure"
      role="alert"
    >
      {{ failure }}
    </p>
    <RowSkeleton v-if="!favourites.loaded" />
    <p
      v-else-if="favourites.error"
      role="alert"
    >
      {{ $t(`errors.${favourites.error.code}`) }}
    </p>
    <p
      v-else-if="favourites.items.length === 0"
      class="favourites-empty"
    >
      {{ $t('favourites.empty') }}
    </p>
    <table
      v-else
      class="file-list trash-list favourites-list"
      :aria-label="$t('favourites.title')"
    >
      <thead>
        <tr>
          <th scope="col">
            {{ $t('favourites.columns.name') }}
          </th>
          <th scope="col">
            {{ $t('favourites.columns.location') }}
          </th>
          <th scope="col">
            <span class="visually-hidden">{{ $t('favourites.columns.actions') }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="f in favourites.items"
          :key="f.id"
          :data-type="f.type"
          :data-available="f.available"
        >
          <td class="name">
            <div class="name-inner">
              <img
                v-if="f.available && hasThumbnail(f) && !thumbFailed.has(f.id)"
                class="row-thumb"
                :src="thumbnailHref(f.source, { path: f.path, modified: f.createdAt }, 128)"
                alt=""
                loading="lazy"
                @error="thumbFailed.add(f.id)"
              >
              <span
                v-else
                class="icon"
                :class="f.type === 'directory' ? 'icon-folder' : 'icon-file'"
                aria-hidden="true"
              />
              <span
                class="name-text"
                :title="f.name"
              >{{ f.name }}</span>
            </div>
          </td>
          <td class="origin">
            <span
              class="origin-text"
              :title="location(f)"
            >{{ location(f) }}</span>
            <span
              v-if="!f.available"
              class="favourite-unavailable"
            >{{ $t('favourites.unavailable') }}</span>
          </td>
          <td class="actions">
            <RouterLink
              v-if="f.available"
              class="button"
              :to="target(f)"
              :aria-label="$t('favourites.openLabel', { name: f.name })"
            >
              {{ $t('favourites.open') }}
            </RouterLink>
            <button
              type="button"
              class="button"
              :aria-label="$t('favourites.removeLabel', { name: f.name })"
              @click="remove(f)"
            >
              {{ $t('favourites.removeShort') }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
