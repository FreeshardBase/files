<script setup lang="ts">
// The member's favourites (#155) across their sources, in the order they were starred. A folder opens itself, a file
// opens its folder with the file selected. A favourite whose source is gone (an unlinked connection, a revoked share) is
// shown as unavailable and can only be removed.
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Favourite } from '@files/shared';
import { useFavouritesStore } from '../stores/favourites.ts';
import { useConnectionsStore } from '../stores/connections.ts';
import { ApiFailure } from '../api/client.ts';
import { folderRoute } from '../api/paths.ts';

const { t } = useI18n();
const favourites = useFavouritesStore();
const connections = useConnectionsStore();
const status = ref('');
const failure = ref('');
const title = ref<HTMLElement>();
onMounted(() => { void favourites.load(); });

const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
function sourceLabel(source: string): string {
  if (source === 'home') return t('nav.home');
  const c = connections.bySource(source);
  if (c) return t('nav.connection', { provider: c.providerName, account: c.account });
  return source.startsWith('share:') ? t('nav.shared') : t('nav.connections');
}
const location = (f: Favourite) => {
  const parent = parentOf(f.path);
  return parent === '/' ? sourceLabel(f.source) : `${sourceLabel(f.source)}${parent}`;
};
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
  <section class="favourites">
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
    <p v-if="!favourites.loaded">
      {{ $t('folder.loading') }}
    </p>
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
              <span
                class="icon"
                :class="f.type === 'directory' ? 'icon-folder' : 'icon-file'"
                aria-hidden="true"
              />
              {{ f.name }}
            </div>
          </td>
          <td class="origin">
            {{ location(f) }}
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
