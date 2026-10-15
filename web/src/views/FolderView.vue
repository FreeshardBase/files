<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { CollisionPolicy, Entry, ErrorCode } from '@files/shared';
import { join, useFolderStore } from '../stores/folder.ts';
import { ApiFailure } from '../api/client.ts';
import { folderRoute } from '../api/paths.ts';
import FileList, { type ItemAction } from '../components/FileList.vue';
import Breadcrumbs from '../components/Breadcrumbs.vue';
import UploadButton from '../components/UploadButton.vue';
import CollisionDialog, { type CollisionChoice } from '../components/CollisionDialog.vue';
import RenameDialog from '../components/RenameDialog.vue';

const route = useRoute(); const router = useRouter(); const { t } = useI18n();
const folder = useFolderStore();
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

const folderName = computed(() => path.value === '/' ? t('nav.home') : path.value.split('/').pop()!);
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
function open(e: Entry) {
  if (e.type === 'directory') void router.push(folderRoute(source.value, e.path));
}

// The open collision question; answering it resolves the promise the batch loop waits on.
const conflict = ref<{ name: string; remaining: number; returnFocus?: HTMLElement | null; answer: (c: CollisionChoice) => void } | null>(null);
const uploadButton = ref<InstanceType<typeof UploadButton>>();
const list = ref<InstanceType<typeof FileList>>();
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

async function upload(files: File[]) {
  const at = { source: folder.source, dir: folder.path }; // captured: navigating away mid-batch must not redirect the remaining files
  failures.value = null;
  try {
    const r = await batch(files, (f) => f.name, (f, policy) => folder.upload(f, at, policy, (x) => {
      status.value = t('upload.progress', { name: f.name, percent: Math.round(x * 100) });
    }), uploadButton.value?.input);
    showFailures(t('upload.failedHeading'), r.failed, 'upload.failedItem');
    status.value = r.skipped ? t('upload.summarySkipped', { done: r.done, total: files.length, skipped: r.skipped })
      : t('upload.summary', { done: r.done, total: files.length });
  } finally {
    await settle(at);
  }
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

function onAction(action: ItemAction, entries: Entry[]) {
  if (action === 'rename') renaming.value = entries[0]!;
  else if (action === 'trash') void trash(entries);
  else {
    const mode = action === 'cut' ? 'move' : 'copy';
    folder.clipboard = { mode, source: folder.source, entries };
    status.value = t(mode === 'move' ? 'transfer.markedMove' : 'transfer.markedCopy', { count: entries.length });
  }
}
async function paste() {
  const clip = folder.clipboard;
  if (!clip) return;
  if (clip.mode === 'move') folder.clipboard = null; // a moved item is gone from where it was marked
  await transfer(clip.mode, clip.entries.map((e) => ({ from: e.path, name: e.name })), folder.path, clip.source);
}
function onDrop(paths: string[], dir: string) {
  void transfer('move', paths.map((p) => ({ from: p, name: baseName(p) })), dir);
}
</script>

<template>
  <section class="folder">
    <div class="toolbar">
      <Breadcrumbs
        :source="source"
        :path="path"
        @drop="onDrop"
      />
      <UploadButton
        ref="uploadButton"
        @files="upload"
      />
    </div>
    <div
      v-if="selectedEntries.length || folder.clipboard"
      class="selection-bar"
      role="group"
      :aria-label="$t('actions.toolbar')"
    >
      <template v-if="selectedEntries.length">
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
      <template v-if="folder.clipboard">
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
    <FileList
      v-else
      ref="list"
      v-model:selected="selected"
      :entries="folder.entries"
      :folder-name="folderName"
      :source="source"
      @open="open"
      @action="onAction"
      @paste="paste"
      @drop="onDrop"
    />
  </section>
</template>
