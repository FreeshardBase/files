<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { CollisionPolicy, Entry, ErrorCode } from '@files/shared';
import { join, useFolderStore } from '../stores/folder.ts';
import { api, ApiFailure } from '../api/client.ts';
import { downloadHref, folderRoute, sourceApi } from '../api/paths.ts';
import ShareDialog from '../components/ShareDialog.vue';
import DetailsDrawer from '../components/DetailsDrawer.vue';
import FileList, { type ItemAction } from '../components/FileList.vue';
import Breadcrumbs from '../components/Breadcrumbs.vue';
import UploadButton from '../components/UploadButton.vue';
import CollisionDialog, { type CollisionChoice } from '../components/CollisionDialog.vue';
import RenameDialog from '../components/RenameDialog.vue';
import PreviewDialog from '../components/PreviewDialog.vue';
import GalleryGrid from '../components/GalleryGrid.vue';
import { useUploadsStore, type PickedFile } from '../stores/uploads.ts';
import { acceptFileDrag, droppedFiles } from '../dnd.ts';

const route = useRoute(); const router = useRouter(); const { t } = useI18n();
const folder = useFolderStore();
const uploads = useUploadsStore();
const status = ref('');
const source = computed(() => String(route.params.source));
const path = computed(() => {
  const p = route.params.path; const segs = Array.isArray(p) ? p : p ? [p] : [];
  return '/' + segs.join('/');
});
// What the last batch could not do, under the heading of that batch (upload or move/copy/trash).
const failures = ref<{ heading: string; items: string[] } | null>(null);
const selected = ref<string[]>([]);
watch([source, path], ([s, p]) => {
  status.value = ''; failures.value = null; selected.value = [];
  void folder.open(p, { source: s });
}, { immediate: true });
// A relist drops whatever is gone from the selection.
watch(() => folder.entries, (entries) => {
  const there = new Set(entries.map((e) => e.path));
  selected.value = selected.value.filter((p) => there.has(p));
});
const selectedEntries = computed(() => folder.entries.filter((e) => selected.value.includes(e.path)));

// A share (#146) is named after the shared item, from its own `stat`; the folders above it in the owner's home stay hidden.
const shareName = ref<string | null>(null);
watch(source, async (s) => {
  shareName.value = null;
  if (s === 'home') return;
  try {
    const root = await api.get<Entry>(`${sourceApi(s)}/stat`, { path: '/' });
    if (source.value === s) shareName.value = root.name;
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e; // handled: the listing of the same source reports the failure
  }
}, { immediate: true });
const rootLabel = computed(() => source.value === 'home' ? t('nav.breadcrumbRoot') : (shareName.value ?? t('nav.shared')));
const folderName = computed(() => path.value === '/' ? (source.value === 'home' ? t('nav.home') : rootLabel.value) : path.value.split('/').pop()!);
// What the caller may do here: change only with `edit` (re-checked by the server on every request); share and upload
// only in their own home, since a share is never shared on and resumable uploads target the home (DECISIONS, #146).
const editable = computed(() => folder.access === 'edit' && folder.source === source.value);
const own = computed(() => source.value === 'home');
const sharing = ref<Entry | null>(null);
const details = ref<Entry | null>(null);
async function shareFromDetails() {
  const e = details.value!;
  details.value = null;
  await nextTick(); // the drawer has put the focus back on the row, which the share dialog then returns to
  sharing.value = e;
}
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
// The preview steps through the folder's files in list order.
const files = computed(() => folder.entries.filter((e) => e.type === 'file'));
const preview = ref<{ files: Entry[]; start: number } | null>(null);
function open(e: Entry) {
  if (e.type === 'directory') void router.push(folderRoute(source.value, e.path));
  else preview.value = { files: files.value, start: files.value.findIndex((f) => f.path === e.path) };
}
async function closePreview(path: string) {
  preview.value = null;
  await nextTick(); // after AppDialog restored focus to where the preview was opened
  (view.value === 'gallery' ? gallery.value : list.value)?.focusPath(path);
}

// List or gallery (#144), remembered on this device across folders and reloads.
type View = 'list' | 'gallery';
const VIEW_KEY = 'files.view';
const view = ref<View>(localStorage.getItem(VIEW_KEY) === 'gallery' ? 'gallery' : 'list');
function setView(v: View) { view.value = v; localStorage.setItem(VIEW_KEY, v); }
const gallery = ref<InstanceType<typeof GalleryGrid>>();

// The open collision question; answering it resolves the promise the batch loop waits on.
const conflict = ref<{ name: string; remaining: number; returnFocus?: HTMLElement | null; answer: (c: CollisionChoice) => void } | null>(null);
const uploadButton = ref<InstanceType<typeof UploadButton>>();
const list = ref<InstanceType<typeof FileList>>();

// `?select=<path>` (a search result, #145): once this folder's list is in, that item is selected and focused.
const pendingSelect = ref<string | null>(null);
async function applySelect() {
  const want = pendingSelect.value;
  if (!want || folder.loading || folder.path !== path.value || folder.source !== source.value) return;
  pendingSelect.value = null;
  if (!folder.entries.some((e) => e.path === want)) return; // gone meanwhile: the folder shows what is there
  selected.value = [want];
  await nextTick();
  (view.value === 'gallery' ? gallery.value : list.value)?.focusPath(want);
}
watch(() => route.query.select, (s) => {
  pendingSelect.value = typeof s === 'string' ? s : null;
  void applySelect();
}, { immediate: true });
watch([() => folder.entries, () => folder.loading], () => { void applySelect(); });
const ask = (name: string, remaining: number, returnFocus?: HTMLElement | null) => new Promise<CollisionChoice>((resolve) => {
  conflict.value = { name, remaining, returnFocus, answer: (c) => { conflict.value = null; resolve(c); } };
});

type Outcome = { done: number; skipped: number; placed: Entry[]; failed: { name: string; code: ErrorCode | 'NETWORK' }[] };
/**
 * Sends the items one by one. The server is always asked with `fail` first (it answers before reading an upload
 * body); a taken name asks the collision question, once for all remaining items if the user says so.
 */
async function batch<T>(items: T[], nameOf: (x: T) => string, send: (x: T, policy: CollisionPolicy) => Promise<Entry>,
  returnFocus?: HTMLElement | null): Promise<Outcome> {
  const out: Outcome = { done: 0, skipped: 0, placed: [], failed: [] };
  let forAll: CollisionChoice['policy'] | null = null; // "apply to all remaining"
  for (const [i, x] of items.entries()) {
    try {
      if (forAll === 'replace' || forAll === 'keep-both') { out.placed.push(await send(x, forAll)); out.done++; continue; }
      const taken = await send(x, 'fail').then((e) => { out.placed.push(e); return null; }, (e: unknown) => {
        if (e instanceof ApiFailure && e.code === 'FILE_EXISTS') return e; // handled: the collision is resolved below
        throw e;
      });
      if (!taken) { out.done++; continue; }
      let policy: CollisionChoice['policy'] = 'skip'; // forAll is null or "skip" here
      if (!forAll) {
        const c = await ask(typeof taken.params?.name === 'string' ? taken.params.name : nameOf(x), items.length - i - 1, returnFocus);
        policy = c.policy; if (c.all) forAll = c.policy;
      }
      if (policy === 'skip') { out.skipped++; continue; }
      out.placed.push(await send(x, policy)); out.done++;
    } catch (e) {
      if (!(e instanceof ApiFailure)) throw e;
      out.failed.push({ name: nameOf(x), code: e.code });
    }
  }
  return out;
}
const showFailures = (heading: string, failed: Outcome['failed'], item: string) => {
  failures.value = failed.length
    ? { heading, items: failed.map((f) => t(item, { name: f.name, reason: t(`errors.${f.code}`) })) } : null;
};
// Relist once per batch (the list stays mounted) and, if the action took the focused row away, refocus the list.
async function settle(at: { source: string; dir: string }) {
  if (at.dir === folder.path && at.source === folder.source) await folder.open(at.dir, { refresh: true });
  await nextTick();
  if (!conflict.value && !renaming.value && (document.activeElement === document.body || !document.activeElement)) list.value?.focus();
}

// Uploads run in the uploads store (resumable, one panel); failures are summarised there, so this only reports the
// batch in the status line and relists once it has an outcome.
function upload(files: PickedFile[]) {
  const at = { source: folder.source, dir: folder.path }; // captured: navigating away mid-batch must not redirect the remaining files
  failures.value = null;
  uploads.enqueue(files, at, { returnFocus: uploadButton.value?.input, settled: (r) => {
    status.value = r.skipped ? t('upload.summarySkipped', { done: r.done, total: r.total, skipped: r.skipped })
      : t('upload.summary', { done: r.done, total: r.total });
    void settle(at);
  } });
}

// Files and folders dragged in from the desktop upload into the open folder.
const dropActive = ref(false);
function onFileDragOver(e: DragEvent) { if (own.value && acceptFileDrag(e)) dropActive.value = true; }
function onFileDragLeave(e: DragEvent) {
  if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) dropActive.value = false;
}
async function onFileDrop(e: DragEvent) {
  dropActive.value = false;
  if (!own.value) return;
  const files = droppedFiles(e);
  if (!files) return;
  const picked = await files;
  if (picked.length) upload(picked);
}

type Item = { from: string; name: string };
/** Moves (renames) or copies items into `dir` of `from`'s source. A move onto the same place is left out. */
async function transfer(op: 'move' | 'copy', items: Item[], dir: string, from = folder.source): Promise<Outcome | null> {
  const todo = op === 'move' ? items.filter((x) => join(dir, x.name) !== x.from) : items;
  if (!todo.length) return null;
  const at = { source: folder.source, dir: folder.path };
  failures.value = null;
  try {
    const r = await batch(todo, (x) => x.name, (x, policy) => folder.transfer(op, from, x.from, join(dir, x.name), policy));
    showFailures(t('transfer.failedHeading'), r.failed, 'transfer.failedItem');
    status.value = r.skipped ? t(`transfer.${op}SummarySkipped`, { done: r.done, total: todo.length, skipped: r.skipped })
      : t(`transfer.${op}Summary`, { done: r.done, total: todo.length });
    return r;
  } finally {
    await settle(at);
  }
}

async function trash(entries: Entry[]) {
  const at = { source: folder.source, dir: folder.path };
  failures.value = null;
  try {
    await folder.trash(at.source, entries.map((e) => e.path));
    status.value = t('transfer.trashed', { count: entries.length });
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    status.value = '';
    failures.value = { heading: t('transfer.failedHeading'), items: [t(`errors.${e.code}`)] };
  } finally {
    await settle(at);
  }
}

const renaming = ref<Entry | null>(null);
async function rename(name: string) {
  const e = renaming.value!;
  renaming.value = null;
  if (name === e.name) return;
  const r = await transfer('move', [{ from: e.path, name }], parentOf(e.path));
  const placed = r?.placed[0];
  if (placed && r.failed.length === 0) status.value = t('transfer.renamed', { name: placed.name });
}

// The server sends an attachment; a link with `download` keeps the page even if the request fails.
function download(entries: Entry[]) {
  const a = document.createElement('a');
  a.href = downloadHref(folder.source, entries);
  a.download = '';
  a.click();
}

function onAction(action: ItemAction, entries: Entry[]) {
  if (action === 'download') download(entries);
  else if (action === 'share') sharing.value = entries[0]!;
  else if (action === 'details') details.value = entries[0]!;
  else if (action === 'rename') renaming.value = entries[0]!;
  else if (action === 'trash') void trash(entries);
  else {
    const mode = action === 'cut' ? 'move' : 'copy';
    folder.clipboard = { mode, source: folder.source, entries };
    status.value = t(mode === 'move' ? 'transfer.markedMove' : 'transfer.markedCopy', { count: entries.length });
  }
}
// Items move and copy within their own source only (moves between sources are #152).
const canPaste = computed(() => editable.value && folder.clipboard?.source === source.value);
async function paste() {
  const clip = folder.clipboard;
  if (!clip || !canPaste.value) return;
  if (clip.mode === 'move') folder.clipboard = null; // a moved item is gone from where it was marked
  await transfer(clip.mode, clip.entries.map((e) => ({ from: e.path, name: e.name })), folder.path, clip.source);
}
function onDrop(paths: string[], dir: string) {
  if (!editable.value) return;
  void transfer('move', paths.map((p) => ({ from: p, name: baseName(p) })), dir);
}
</script>

<template>
  <section
    class="folder"
    :class="{ 'drop-active': dropActive }"
    @dragover="onFileDragOver"
    @dragleave="onFileDragLeave"
    @drop="onFileDrop"
  >
    <p
      v-if="dropActive"
      class="drop-hint"
    >
      {{ $t('upload.dropHint', { folder: folderName }) }}
    </p>
    <div class="toolbar">
      <Breadcrumbs
        :source="source"
        :path="path"
        :root-label="rootLabel"
        :editable="editable"
        @drop="onDrop"
      />
      <div class="toolbar-actions">
        <div
          class="view-toggle"
          role="group"
          :aria-label="$t('view.label')"
        >
          <button
            v-for="v in (['list', 'gallery'] as const)"
            :key="v"
            type="button"
            class="button"
            :aria-pressed="view === v"
            @click="setView(v)"
          >
            {{ $t(`view.${v}`) }}
          </button>
        </div>
        <UploadButton
          v-if="own"
          ref="uploadButton"
          @files="upload"
        />
      </div>
    </div>
    <div
      v-if="selectedEntries.length || canPaste"
      class="selection-bar"
      role="group"
      :aria-label="$t('actions.toolbar')"
    >
      <template v-if="selectedEntries.length">
        <a
          class="button"
          :href="downloadHref(source, selectedEntries)"
          download
        >
          {{ $t('actions.download') }}
        </a>
        <template v-if="editable">
          <button
            v-if="selectedEntries.length === 1"
            type="button"
            class="button"
            @click="onAction('rename', selectedEntries)"
          >
            {{ $t('actions.rename') }}
          </button>
          <button
            type="button"
            class="button"
            @click="onAction('cut', selectedEntries)"
          >
            {{ $t('actions.cut') }}
          </button>
          <button
            type="button"
            class="button"
            @click="onAction('copy', selectedEntries)"
          >
            {{ $t('actions.copy') }}
          </button>
          <button
            type="button"
            class="button danger"
            @click="onAction('trash', selectedEntries)"
          >
            {{ $t('actions.trash') }}
          </button>
        </template>
      </template>
      <template v-if="folder.clipboard && canPaste">
        <button
          type="button"
          class="button primary"
          @click="paste"
        >
          {{ $t(folder.clipboard.mode === 'move' ? 'actions.pasteMove' : 'actions.pasteCopy', { count: folder.clipboard.entries.length }) }}
        </button>
        <button
          type="button"
          class="button"
          @click="folder.clipboard = null"
        >
          {{ $t('actions.clearClipboard') }}
        </button>
      </template>
    </div>
    <CollisionDialog
      v-if="conflict"
      :name="conflict.name"
      :remaining="conflict.remaining"
      :return-focus="conflict.returnFocus"
      @choose="conflict.answer"
    />
    <RenameDialog
      v-if="renaming"
      :name="renaming.name"
      :is-folder="renaming.type === 'directory'"
      @submit="rename"
      @cancel="renaming = null"
    />
    <ShareDialog
      v-if="sharing"
      :source="source"
      :entry="sharing"
      @close="sharing = null"
    />
    <DetailsDrawer
      v-if="details"
      :source="source"
      :entry="details"
      :access="folder.access"
      @close="details = null"
      @share="shareFromDetails"
    />
    <PreviewDialog
      v-if="preview"
      :files="preview.files"
      :start="preview.start"
      :source="source"
      @close="closePreview"
    />
    <p
      class="status"
      role="status"
      aria-live="polite"
    >
      {{ status }}
    </p>
    <div
      v-if="failures"
      class="upload-failures"
    >
      <p>{{ failures.heading }}</p>
      <ul>
        <li
          v-for="(f, i) in failures.items"
          :key="i"
        >
          {{ f }}
        </li>
      </ul>
    </div>
    <p v-if="folder.loading">
      {{ $t('folder.loading') }}
    </p>
    <p
      v-else-if="folder.error"
      role="alert"
    >
      {{ $t(`errors.${folder.error.code}`) }}
    </p>
    <p v-else-if="folder.entries.length === 0">
      {{ $t('folder.empty') }}
    </p>
    <GalleryGrid
      v-else-if="view === 'gallery'"
      ref="gallery"
      :entries="folder.entries"
      :folder-name="folderName"
      :source="source"
      @open="open"
    />
    <FileList
      v-else
      ref="list"
      v-model:selected="selected"
      :entries="folder.entries"
      :folder-name="folderName"
      :source="source"
      :editable="editable"
      :shareable="own"
      @open="open"
      @action="onAction"
      @paste="paste"
      @drop="onDrop"
    />
  </section>
</template>
