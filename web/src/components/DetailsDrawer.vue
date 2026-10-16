<script setup lang="ts">
// The details drawer of one item (#146, absorbs #52): type, size, modified, location, and who has access. In the
// member's own home and own cloud connections it lists the members the item is shared with and offers "Share …" (#208);
// in a share it shows the caller's own access. A file's versions follow (#154); the item can be starred (#155). Esc or "Close" closes it; focus returns
// to the row.
import { computed, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Access, Entry, Share, ShareList } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { formatDate, formatSize, intlLocale } from '../format.ts';
import AppDialog from './AppDialog.vue';
import VersionHistory from './VersionHistory.vue';
import { useFavouritesStore } from '../stores/favourites.ts';

const props = defineProps<{ source: string; entry: Entry; access: Access; returnFocus?: HTMLElement | null }>();
const emit = defineEmits<{ close: []; share: []; restored: [entry: Entry] }>();
const { t, locale } = useI18n();
const own = !props.source.startsWith('share:');
const shares = ref<Share[] | null>(null);
const error = ref('');
const whoId = useId();
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
// The item's star (#155), the same toggle as in its row.
const favourites = useFavouritesStore();
const favourite = computed(() => favourites.find(props.source, props.entry.path) !== undefined);
const favouriteError = ref('');
async function toggleFavourite() {
  favouriteError.value = '';
  try { await favourites.toggle(props.source, props.entry.path); }
  catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    favouriteError.value = t(`errors.${e.code}`);
  }
}

onMounted(async () => {
  if (!own) return;
  try { shares.value = (await api.get<ShareList>('/api/v1/shares', { source: props.source, path: props.entry.path })).items; }
  catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    error.value = t(`errors.${e.code}`);
  }
});
</script>

<template>
  <AppDialog
    :title="t('details.title', { name: entry.name })"
    :return-focus="returnFocus"
    drawer
    @close="emit('close')"
  >
    <dl class="details-facts">
      <dt>{{ t('details.type') }}</dt>
      <dd>{{ entry.type === 'directory' ? t('details.folder') : (entry.mime ?? t('details.file')) }}</dd>
      <template v-if="entry.type === 'file'">
        <dt>{{ t('details.size') }}</dt>
        <dd class="value-mono">
          {{ formatSize(entry.size, intlLocale(locale)) }}
        </dd>
      </template>
      <template v-if="entry.modified">
        <dt>{{ t('details.modified') }}</dt>
        <dd class="value-mono">
          {{ formatDate(entry.modified, intlLocale(locale)) }}
        </dd>
      </template>
      <dt>{{ t('details.location') }}</dt>
      <dd>{{ parentOf(entry.path) }}</dd>
    </dl>
    <h3
      :id="whoId"
      class="share-heading"
    >
      {{ t('share.whoHasAccess') }}
    </h3>
    <p
      v-if="error"
      role="alert"
    >
      {{ error }}
    </p>
    <ul
      v-else-if="!own || (shares && shares.length)"
      class="share-list"
      :aria-labelledby="whoId"
    >
      <li v-if="!own">
        <span class="share-name">{{ t('details.you') }}</span>
        <span class="share-level fs-pill">{{ t(`share.${access}`) }}</span>
      </li>
      <li
        v-for="s in shares ?? []"
        :key="s.id"
      >
        <span class="share-name">{{ s.grantee.displayName }}</span>
        <span class="share-level fs-pill">{{ t(`share.${s.access}`) }}</span>
      </li>
    </ul>
    <p
      v-else-if="shares"
      class="share-note"
    >
      {{ t('share.onlyYou') }}
    </p>
    <VersionHistory
      v-if="entry.type === 'file'"
      :source="source"
      :entry="entry"
      @restored="emit('restored', $event)"
    />
    <p
      v-if="favouriteError"
      role="alert"
    >
      {{ favouriteError }}
    </p>
    <template #actions>
      <button
        type="button"
        class="button star-button"
        :aria-pressed="favourite"
        @click="toggleFavourite"
      >
        <span
          class="icon"
          :class="favourite ? 'icon-star-filled' : 'icon-star'"
          aria-hidden="true"
        />
        {{ t('favourites.drawerToggle') }}
      </button>
      <button
        v-if="own"
        type="button"
        class="button primary"
        @click="emit('share')"
      >
        {{ t('details.share') }}
      </button>
      <button
        type="button"
        class="button"
        @click="emit('close')"
      >
        {{ t('share.close') }}
      </button>
    </template>
  </AppDialog>
</template>
