<script setup lang="ts">
// The details drawer of one item (#146, absorbs #52): type, size, modified, location, and who has access. In the
// member's own home it lists the members the item is shared with and offers "Share …"; in a share it shows the caller's
// own access. Esc or "Close" closes it; focus returns to the row.
import { onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Access, Entry, Share, ShareList } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { formatDate, formatSize, intlLocale } from '../format.ts';
import AppDialog from './AppDialog.vue';

const props = defineProps<{ source: string; entry: Entry; access: Access; returnFocus?: HTMLElement | null }>();
const emit = defineEmits<{ close: []; share: [] }>();
const { t, locale } = useI18n();
const own = props.source === 'home';
const shares = ref<Share[] | null>(null);
const error = ref('');
const whoId = useId();
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

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
        <dd>{{ formatSize(entry.size, intlLocale(locale)) }}</dd>
      </template>
      <dt>{{ t('details.modified') }}</dt>
      <dd>{{ formatDate(entry.modified, intlLocale(locale)) }}</dd>
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
        <span class="share-level">{{ t(`share.${access}`) }}</span>
      </li>
      <li
        v-for="s in shares ?? []"
        :key="s.id"
      >
        <span class="share-name">{{ s.grantee.displayName }}</span>
        <span class="share-level">{{ t(`share.${s.access}`) }}</span>
      </li>
    </ul>
    <p
      v-else-if="shares"
      class="share-note"
    >
      {{ t('share.onlyYou') }}
    </p>
    <template #actions>
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
