<script setup lang="ts">
// "My shares" (#299): every public link of the member and every share they granted, across all their sources, in one
// place. Each row names its item (folder label and name; a folder opens itself, a file its folder with the file
// selected). Links: copy, edit (the item's share dialog, the same one the folder view opens) and revoke after a
// confirmation (#232). Shares: remove. An orphaned link or share can only be revoked or removed.
// Class names avoid the generic ad-block rules (#295, `e2e/fixtures/generic-cosmetic-rules.txt`).
import { nextTick, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Entry, MyLink, MyLinkList, OutgoingShare, OutgoingShareList } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';
import { folderRoute } from '../api/paths.ts';
import { formatDate, intlLocale } from '../format.ts';
import { memberName } from '../memberName.ts';
import { parentOf, useLocations } from '../location.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import RowSkeleton from '../components/RowSkeleton.vue';
import ShareDialog from '../components/ShareDialog.vue';

const { t, locale } = useI18n();
const { folderLabel } = useLocations();
const links = ref<MyLink[]>([]);
const shares = ref<OutgoingShare[]>([]);
const loaded = ref(false);
const error = ref(''); const status = ref('');
const linksId = useId(); const sharesId = useId();
const title = ref<HTMLElement>();

const fail = (e: unknown) => { if (!(e instanceof ApiFailure)) throw e; error.value = t(`errors.${e.code}`); };
async function load() {
  const [l, s] = await Promise.all([api.get<MyLinkList>('/api/v1/links/mine'), api.get<OutgoingShareList>('/api/v1/shares/outgoing')]);
  links.value = l.items; shares.value = s.items;
}
onMounted(async () => {
  try { await load(); } catch (e) { fail(e); } finally { loaded.value = true; }
});

type Item = { source: string; path: string; type: 'file' | 'directory' };
const nameOf = (i: Item) => i.path.slice(i.path.lastIndexOf('/') + 1);
const where = (i: Item) => folderLabel(i.source, parentOf(i.path));
const target = (i: Item) => i.type === 'directory' ? folderRoute(i.source, i.path)
  : { path: folderRoute(i.source, parentOf(i.path)), query: { select: i.path } };
const linkName = (l: MyLink) => l.label || t('link.unnamed');
const address = (l: MyLink) => `${location.origin}/s/${l.token}`;
const downloads = (l: MyLink) => l.maxDownloads === null
  ? t('link.downloads', { count: l.downloads }, l.downloads)
  : t('link.downloadsOf', { count: l.downloads, max: l.maxDownloads });

// The address fields by link id, so "Copy" can fall back to selecting the address.
const inputs = new Map<string, HTMLInputElement>();
const setInput = (id: string, el: unknown) => { if (el instanceof HTMLInputElement) inputs.set(id, el); else inputs.delete(id); };
async function copy(l: MyLink) {
  try {
    await navigator.clipboard.writeText(address(l));
    status.value = t('link.copied');
  } catch {
    // handled: no clipboard (plain http, permission): the address is selected for the member to copy themselves
    const input = inputs.get(l.id);
    input?.focus(); input?.select();
    status.value = t('link.copyManually');
  }
}

// Editing opens the item's share dialog; whatever changed there shows here once it closes.
const editing = ref<{ source: string; entry: Entry } | null>(null);
const edit = (l: MyLink) => { editing.value = { source: l.source, entry: { name: nameOf(l), path: l.path, type: l.type, size: 0 } }; };
async function closeEdit() {
  editing.value = null;
  try { await load(); } catch (e) { fail(e); }
}

const revoking = ref<MyLink | null>(null);
async function revoke() {
  const l = revoking.value!;
  revoking.value = null;
  await nextTick(); // the question is gone and has put the focus back on the row's button
  error.value = ''; status.value = '';
  try {
    await api.delete(`/api/v1/links/${encodeURIComponent(l.id)}`);
    await load();
    status.value = t('link.revoked', { name: linkName(l) });
    title.value?.focus(); // the focused button is gone with its row
  } catch (e) { fail(e); }
}
async function removeShare(s: OutgoingShare) {
  error.value = ''; status.value = '';
  try {
    await api.delete(`/api/v1/shares/${encodeURIComponent(s.id)}`);
    await load();
    status.value = t('myShares.removed', { name: nameOf(s), member: memberName(s.grantee) });
    title.value?.focus(); // the focused button is gone with its row
  } catch (e) { fail(e); }
}
</script>

<template>
  <section class="page mine-page">
    <div class="toolbar">
      <h1
        ref="title"
        class="view-title"
        tabindex="-1"
      >
        {{ t('myShares.title') }}
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
      v-if="error"
      class="fs-field__error"
      role="alert"
    >
      {{ error }}
    </p>
    <RowSkeleton v-if="!loaded" />
    <p
      v-else-if="links.length === 0 && shares.length === 0"
      class="recent-empty"
    >
      {{ t('myShares.empty') }}
    </p>
    <template v-else>
      <h2
        :id="linksId"
        class="fs-section-heading"
      >
        {{ t('link.heading') }}
      </h2>
      <p
        v-if="links.length === 0"
        class="share-note"
      >
        {{ t('myShares.noLinks') }}
      </p>
      <ul
        v-else
        class="fs-entry-list fs-link-rows mine-rows"
        :aria-labelledby="linksId"
      >
        <li
          v-for="l in links"
          :key="l.id"
        >
          <RouterLink
            class="mine-item"
            :to="target(l)"
            :aria-label="t('myShares.openLabel', { name: nameOf(l) })"
          >
            <span
              class="icon"
              :class="l.type === 'directory' ? 'icon-folder' : 'icon-file'"
              aria-hidden="true"
            />
            <span class="mine-item-name">{{ nameOf(l) }}</span>
          </RouterLink>
          <span class="mine-where">{{ where(l) }}</span>
          <span class="share-name">{{ linkName(l) }}</span>
          <span class="share-level">
            <template v-if="l.orphaned">{{ t('link.orphaned') }}</template>
            <template v-else>
              {{ l.hasPassword ? t('link.withPassword') : t('link.noPassword') }} ·
              {{ l.expiresAt ? t('link.expires', { date: formatDate(l.expiresAt, intlLocale(locale)) }) : t('link.noExpiry') }} ·
              {{ downloads(l) }}
            </template>
          </span>
          <input
            v-if="!l.orphaned"
            :ref="(el) => setInput(l.id, el)"
            class="fs-input link-address"
            type="text"
            readonly
            :value="address(l)"
            :aria-label="t('link.address', { name: linkName(l) })"
            @focus="($event.target as HTMLInputElement).select()"
          >
          <span class="link-buttons">
            <button
              v-if="!l.orphaned"
              type="button"
              class="button"
              :aria-label="t('link.copyLabel', { name: linkName(l) })"
              @click="copy(l)"
            >
              {{ t('link.copy') }}
            </button>
            <button
              v-if="!l.orphaned"
              type="button"
              class="button"
              :aria-label="t('link.editLabel', { name: linkName(l) })"
              @click="edit(l)"
            >
              {{ t('link.edit') }}
            </button>
            <button
              type="button"
              class="button danger"
              :aria-label="t('link.revokeLabel', { name: linkName(l) })"
              @click="revoking = l"
            >
              {{ t('link.revoke') }}
            </button>
          </span>
        </li>
      </ul>
      <h2
        :id="sharesId"
        class="fs-section-heading"
      >
        {{ t('myShares.sharesHeading') }}
      </h2>
      <p
        v-if="shares.length === 0"
        class="share-note"
      >
        {{ t('myShares.noShares') }}
      </p>
      <ul
        v-else
        class="fs-entry-list mine-rows"
        :aria-labelledby="sharesId"
      >
        <li
          v-for="s in shares"
          :key="s.id"
        >
          <RouterLink
            class="mine-item"
            :to="target(s)"
            :aria-label="t('myShares.openLabel', { name: nameOf(s) })"
          >
            <span
              class="icon"
              :class="s.type === 'directory' ? 'icon-folder' : 'icon-file'"
              aria-hidden="true"
            />
            <span class="mine-item-name">{{ nameOf(s) }}</span>
          </RouterLink>
          <span class="mine-where">{{ where(s) }}</span>
          <span class="share-name">{{ memberName(s.grantee) }}</span>
          <span
            class="fs-pill"
            :data-tone="s.orphaned ? 'danger' : undefined"
          >{{ s.orphaned ? t('shared.orphaned') : t(`share.${s.access}`) }}</span>
          <button
            type="button"
            class="button danger"
            :aria-label="t('myShares.removeLabel', { name: nameOf(s), member: memberName(s.grantee) })"
            @click="removeShare(s)"
          >
            {{ t('myShares.remove') }}
          </button>
        </li>
      </ul>
    </template>
    <ShareDialog
      v-if="editing"
      :source="editing.source"
      :entry="editing.entry"
      @close="closeEdit"
    />
    <ConfirmDialog
      v-if="revoking"
      :title="t('link.revokeTitle', { name: linkName(revoking) })"
      :message="t('link.revokeMessage')"
      :confirm-label="t('link.revoke')"
      @confirm="revoke"
      @cancel="revoking = null"
    />
  </section>
</template>
