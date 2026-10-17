<script setup lang="ts">
// The member's local trash: restore (with the collision dialog), delete permanently, empty. Cloud sources use the
// provider's own trash and never show up here.
import { nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TrashItem } from '@files/shared';
import { useTrashStore } from '../stores/trash.ts';
import { ApiFailure } from '../api/client.ts';
import { folderRoute } from '../api/paths.ts';
import { formatDate, formatSize, intlLocale } from '../format.ts';
import CollisionDialog, { type CollisionChoice } from '../components/CollisionDialog.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import RowSkeleton from '../components/RowSkeleton.vue';
import { parentOf, useLocations } from '../location.ts';

const { t, locale } = useI18n();
const trash = useTrashStore();
const heading = ref<HTMLElement>();
const status = ref('');
// Where the last restore put the item, for the "Open folder" link next to the status.
const restoredTo = ref<string | null>(null);
const failure = ref('');
onMounted(() => { void trash.load(); });

// The trash holds the home's items only; their places are written as everywhere else (#244).
const { folderLabel: label } = useLocations();
const folderLabel = (p: string) => label('home', p);
const size = (n: number) => formatSize(n, intlLocale(locale.value));

const fail = (e: unknown) => {
  if (!(e instanceof ApiFailure)) throw e;
  // A count (PURGE_FAILED) picks the singular or plural form (#247).
  const count = e.params?.count;
  failure.value = typeof count === 'number' ? t(`errors.${e.code}`, e.params ?? {}, count) : t(`errors.${e.code}`, e.params ?? {});
};
// Reload once per action; if the action took the focused button away, focus the heading instead of the page.
async function settle() {
  await trash.load();
  await nextTick();
  if (!document.activeElement || document.activeElement === document.body) heading.value?.focus();
}

const conflict = ref<{ name: string; answer: (c: CollisionChoice) => void } | null>(null);
const ask = (name: string) => new Promise<CollisionChoice>((resolve) => {
  conflict.value = { name, answer: (c) => { conflict.value = null; resolve(c); } };
});

async function restore(item: TrashItem) {
  status.value = ''; failure.value = ''; restoredTo.value = null;
  try {
    const placed = await trash.restore(item.id, 'fail').catch(async (e: unknown) => {
      if (!(e instanceof ApiFailure) || e.code !== 'FILE_EXISTS') throw e;
      // handled: the taken name is resolved by asking; never a silent overwrite
      const c = await ask(typeof e.params?.name === 'string' ? e.params.name : item.name);
      return c.policy === 'skip' ? null : trash.restore(item.id, c.policy);
    });
    if (!placed) { status.value = t('trash.notRestored', { name: item.name }); return; }
    const folder = parentOf(placed.path);
    status.value = t('trash.restored', { name: placed.name, folder: folderLabel(folder) });
    restoredTo.value = folder;
  } catch (e) {
    fail(e);
  } finally {
    await settle();
  }
}

// The one confirmation dialog: either one item or the whole trash.
const confirming = ref<{ kind: 'one'; item: TrashItem } | { kind: 'all' } | null>(null);
async function confirmed() {
  const c = confirming.value!;
  confirming.value = null;
  status.value = ''; failure.value = ''; restoredTo.value = null;
  try {
    if (c.kind === 'one') { await trash.purge([c.item.id]); status.value = t('trash.deleted', { name: c.item.name }); }
    else { await trash.empty(); status.value = t('trash.emptied'); }
  } catch (e) {
    fail(e);
  } finally {
    await settle();
  }
}
</script>

<template>
  <section class="page trash">
    <div class="toolbar">
      <h1
        ref="heading"
        class="view-title"
        tabindex="-1"
      >
        {{ $t('trash.title') }}
      </h1>
      <button
        type="button"
        class="button danger"
        :disabled="trash.items.length === 0"
        @click="confirming = { kind: 'all' }"
      >
        {{ $t('trash.emptyButton') }}
      </button>
    </div>
    <p
      v-if="trash.retentionDays"
      class="trash-note"
    >
      {{ $t('trash.retention', { days: trash.retentionDays }, trash.retentionDays) }}
      <template v-if="trash.totalSize">
        {{ $t('trash.usage', { size: size(trash.totalSize) }) }}
      </template>
    </p>
    <CollisionDialog
      v-if="conflict"
      :name="conflict.name"
      :remaining="0"
      @choose="conflict.answer"
    />
    <ConfirmDialog
      v-if="confirming"
      :title="confirming.kind === 'all' ? $t('trash.confirmEmptyTitle') : $t('trash.confirmDeleteTitle')"
      :message="confirming.kind === 'all' ? $t('trash.confirmEmptyMessage', { count: trash.items.length }, trash.items.length)
        : $t('trash.confirmDeleteMessage', { name: confirming.item.name })"
      :confirm-label="confirming.kind === 'all' ? $t('trash.emptyButton') : $t('trash.delete')"
      @confirm="confirmed"
      @cancel="confirming = null"
    />
    <p
      class="status"
      role="status"
      aria-live="polite"
    >
      {{ status }}
      <RouterLink
        v-if="restoredTo"
        :to="folderRoute('home', restoredTo)"
      >
        {{ $t('trash.openFolder') }}
      </RouterLink>
    </p>
    <p
      v-if="failure"
      class="upload-failures"
      role="alert"
    >
      {{ failure }}
    </p>
    <RowSkeleton v-if="!trash.loaded" />
    <p
      v-else-if="trash.error"
      role="alert"
    >
      {{ $t(`errors.${trash.error.code}`) }}
    </p>
    <p v-else-if="trash.items.length === 0">
      {{ $t('trash.empty') }}
    </p>
    <table
      v-else
      class="file-list trash-list"
      :aria-label="$t('trash.title')"
    >
      <thead>
        <tr>
          <th scope="col">
            {{ $t('trash.columns.name') }}
          </th>
          <th scope="col">
            {{ $t('trash.columns.origin') }}
          </th>
          <th scope="col">
            {{ $t('trash.columns.deleted') }}
          </th>
          <th scope="col">
            {{ $t('trash.columns.size') }}
          </th>
          <th scope="col">
            <span class="visually-hidden">{{ $t('trash.columns.actions') }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="item in trash.items"
          :key="item.id"
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
              :title="folderLabel(parentOf(item.originalPath))"
            >{{ folderLabel(parentOf(item.originalPath)) }}</span>
          </td>
          <td class="num date">
            {{ formatDate(item.deletedAt, intlLocale(locale)) }}
          </td>
          <td class="num size">
            {{ size(item.size) }}
          </td>
          <td class="actions">
            <button
              type="button"
              class="button"
              :aria-label="$t('trash.restoreLabel', { name: item.name })"
              @click="restore(item)"
            >
              {{ $t('trash.restore') }}
            </button>
            <button
              type="button"
              class="button danger"
              :aria-label="$t('trash.deleteLabel', { name: item.name })"
              @click="confirming = { kind: 'one', item }"
            >
              {{ $t('trash.delete') }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
