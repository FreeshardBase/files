<script setup lang="ts">
// The details drawer of one item (#146, absorbs #52): type, size, modified, location, and who has access. In the
// member's own home and own cloud connections it lists the members the item is shared with and offers "Share …" (#208);
// in a share it shows the caller's own access. Its tags with the chip editor (#212, with `edit`); a file's versions follow
// (#154); the item can be starred (#155). Esc or the
// head's X closes it; focus returns to the row. Kind and location are words, never a MIME type or a path (#242).
import { computed, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Access, Entry, Share, ShareList } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { formatDate, formatSize, intlLocale } from '../format.ts';
import { fileKind } from '../fileKind.ts';
import AppDialog from './AppDialog.vue';
import VersionHistory from './VersionHistory.vue';
import TagEditor from './TagEditor.vue';
import { useFavouritesStore } from '../stores/favourites.ts';

// `rootLabel`: the name of the source's root as the breadcrumbs show it ("My storage", a share, a cloud account).
const props = defineProps<{ source: string; entry: Entry; access: Access; rootLabel: string; returnFocus?: HTMLElement | null }>();
const emit = defineEmits<{ close: []; share: []; restored: [entry: Entry] }>();
const { t, locale } = useI18n();
const own = !props.source.startsWith('share:');
const shares = ref<Share[] | null>(null);
const error = ref('');
const whoId = useId();
const kind = computed(() => fileKind(props.entry));
// "My storage › Projects": the root's name, then each folder above the item.
const location = computed(() => [props.rootLabel, ...props.entry.path.split('/').slice(1, -1)].join(' › '));
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
    :title="entry.name"
    :label="t('details.label')"
    :close-label="t('share.close')"
    :return-focus="returnFocus"
    drawer
    @close="emit('close')"
  >
    <dl class="details-facts">
      <dt>{{ t('details.type') }}</dt>
      <dd>{{ t(`details.kind.${kind.key}`, kind.params ?? {}) }}</dd>
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
      <dd>{{ location }}</dd>
    </dl>
    <TagEditor
      :source="source"
      :path="entry.path"
      :name="entry.name"
      :editable="access === 'edit'"
    />
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
    </template>
  </AppDialog>
</template>
