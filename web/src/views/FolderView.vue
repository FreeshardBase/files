<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { SORT_KEYS, type CollisionPolicy, type Entry, type ErrorCode, type Sort, type SortKey } from '@files/shared';
import { join, useFolderStore } from '../stores/folder.ts';
import { api, ApiFailure } from '../api/client.ts';
import { downloadHref, folderRoute, sourceApi } from '../api/paths.ts';
import ShareDialog from '../components/ShareDialog.vue';
import DetailsDrawer from '../components/DetailsDrawer.vue';
import FileList from '../components/FileList.vue';
import type { ItemAction } from '../itemActions.ts';
import Breadcrumbs from '../components/Breadcrumbs.vue';
import UploadButton from '../components/UploadButton.vue';
import ItemMenu, { type MenuItem } from '../components/ItemMenu.vue';
import UploadPanel from '../components/UploadPanel.vue';
import CollisionDialog, { type CollisionChoice } from '../components/CollisionDialog.vue';
import RenameDialog from '../components/RenameDialog.vue';
import NewFolderDialog from '../components/NewFolderDialog.vue';
import PreviewDialog from '../components/PreviewDialog.vue';
import GalleryGrid from '../components/GalleryGrid.vue';
import ActionToast, { type Toast } from '../components/ActionToast.vue';
import StateAlert from '../components/StateAlert.vue';
import RowSkeleton from '../components/RowSkeleton.vue';
import { useUploadsStore, type PickedFile } from '../stores/uploads.ts';
import { useConnectionsStore } from '../stores/connections.ts';
import { useTransfersStore } from '../stores/transfers.ts';
import { useFavouritesStore } from '../stores/favourites.ts';
import { useSortStore } from '../stores/sort.ts';
import { useTagsStore } from '../stores/tags.ts';
import { useCommentsStore } from '../stores/comments.ts';
import AddTagDialog from '../components/AddTagDialog.vue';
import { acceptFileDrag, droppedFiles } from '../dnd.ts';
import { sortEntries } from '../sort.ts';
import { intlLocale } from '../format.ts';
import { previewKind } from '../preview.ts';

const route = useRoute(); const router = useRouter(); const { t, locale } = useI18n();
const folder = useFolderStore();
const uploads = useUploadsStore();
const connections = useConnectionsStore();
const transfers = useTransfersStore();
const favourites = useFavouritesStore();
const sortStore = useSortStore();
// The feedback of the last action, shown as a toast (#241); an outcome with failures takes the error kind.
const toast = ref<Toast | null>(null);
let toastId = 0;
const say = (text: string, kind: Toast['kind'] = 'success') => { toast.value = { text, kind, id: ++toastId }; };
const source = computed(() => String(route.params.source));
const path = computed(() => {
  const p = route.params.path; const segs = Array.isArray(p) ? p : p ? [p] : [];
  return '/' + segs.join('/');
});
// What the last batch could not do, under the heading of that batch (upload or move/copy/trash).
const failures = ref<{ heading: string; items: string[] } | null>(null);
const selected = ref<string[]>([]);
// Focus across navigation (#228): when the focus was in this folder view (a row, a tile, a breadcrumb), it waits on the
// content region while the next folder loads, then goes to the row of the folder we came from (going up) or the first
// row, or stays on the region when there is nothing to focus. A navigation from elsewhere (the sidebar) leaves it.
const section = ref<HTMLElement>();
const content = ref<HTMLElement>();
let refocus: { source: string; path: string } | null = null; // where the navigation came from
watch([source, path], ([s, p], [os, op]) => {
  const active = document.activeElement;
  refocus = os !== undefined && op !== undefined && active && section.value?.contains(active) ? { source: os, path: op } : null;
  toast.value = null; failures.value = null; selected.value = [];
  void folder.open(p, { source: s });
  if (refocus) void nextTick(() => content.value?.focus()); // the rows are inert while loading
}, { immediate: true });
// A relist drops whatever is gone from the selection.
watch(() => folder.entries, (entries) => {
  const there = new Set(entries.map((e) => e.path));
  selected.value = selected.value.filter((p) => there.has(p));
});
const selectedEntries = computed(() => {
  const chosen = new Set(selected.value); // Ctrl+A in a large folder (#225): one lookup per entry, not a scan
  return folder.entries.filter((e) => chosen.has(e.path));
});
// The member's sort (#226), applied here to the whole listing (the store loads every page first), for every source.
// Everything that walks the items in order (list, gallery, preview, focus) uses this order.
const sort = computed<Sort>(() => ({ key: sortStore.key, dir: sortStore.dir }));
const entries = computed(() => sortEntries(folder.entries, sort.value, intlLocale(locale.value)));
const SORT_OPTIONS = SORT_KEYS.flatMap((key) => (['asc', 'desc'] as const).map((dir) => `${key}-${dir}`));
// Saved first and applied once the server confirms; a refusal keeps the order and says why.
async function setSort(s: Sort) {
  failures.value = null;
  try { await sortStore.save(s); }
  catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    failures.value = { heading: t('sort.failed'), items: [t(`errors.${e.code}`)] };
  }
}
// A header click sorts by its column; on the sorted column it turns the direction around.
const sortBy = (key: SortKey) => setSort({ key, dir: sort.value.key === key && sort.value.dir === 'asc' ? 'desc' : 'asc' });
function onSortMenu(e: Event) {
  const [key, dir] = (e.target as HTMLSelectElement).value.split('-') as [SortKey, Sort['dir']];
  void setSort({ key, dir });
}
// The selection bar's height (#224): on the phone the bar is fixed at the bottom, and the folder keeps that much room
// below the list so the bar never covers the last row.
const selectionBar = ref<HTMLElement>();
const selectionBarHeight = ref(0);
const barObserver = new ResizeObserver(([e]) => { selectionBarHeight.value = e ? e.borderBoxSize[0]!.blockSize : 0; });
watch(selectionBar, (el, old) => {
  if (old) barObserver.unobserve(old);
  if (el) barObserver.observe(el);
  else selectionBarHeight.value = 0;
});
onUnmounted(() => barObserver.disconnect());

// A share (#146) is named after the shared item, from its own `stat`; the folders above it in the owner's home stay hidden.
const shareName = ref<string | null>(null);
watch(source, async (s) => {
  shareName.value = null;
  if (s === 'home' || s.startsWith('conn:')) return;
  try {
    const root = await api.get<Entry>(`${sourceApi(s)}/stat`, { path: '/' });
    if (source.value === s) shareName.value = root.name;
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e; // handled: the listing of the same source reports the failure
  }
}, { immediate: true });
// A connection (#148) is named after its provider; the account is a muted note beside the root crumb (#244).
const connection = computed(() => connections.bySource(source.value));
const rootLabel = computed(() => source.value === 'home' ? t('nav.breadcrumbRoot')
  : source.value.startsWith('conn:') ? (connection.value?.providerName ?? t('nav.connections'))
  : (shareName.value ?? t('nav.shared')));
const rootNote = computed(() => connection.value?.account ?? '');
const folderName = computed(() => path.value === '/' ? (source.value === 'home' ? t('nav.home') : rootLabel.value) : path.value.split('/').pop()!);
// What the caller may do here: change only with `edit` (re-checked by the server on every request); share in their own
// home and their own cloud connections, never in a share, since a share is never shared on (DECISIONS, #146, #208);
// upload wherever they may change things: the home, their own connections (#149) and shares with `edit` (#208).
const editable = computed(() => folder.access === 'edit' && folder.source === source.value);
const own = computed(() => source.value === 'home');
const shareable = computed(() => !source.value.startsWith('share:'));
// A folder that failed to open offers nothing to do in it (#240): its toolbar is gone and the alert says why.
const canUpload = computed(() => (own.value || editable.value) && !folder.error);
const atHome = computed(() => source.value === 'home' && path.value === '/');
// Loading with nothing in place yet (first open, after an empty folder or an error): the row skeleton. Otherwise the
// previous list stays in place, inert and dimmed, under the loading note (#228).
const skeleton = computed(() => folder.loading && folder.entries.length === 0);
const notFound = computed(() => folder.error?.code === 'NOT_FOUND' || folder.error?.code === 'SOURCE_NOT_FOUND');
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
// The preview steps through the folder's files in list order. An image opened in the gallery is a lightbox that steps
// through the images only (#242).
const files = computed(() => entries.value.filter((e) => e.type === 'file'));
const isImage = (e: Entry) => previewKind(e.mime) === 'image';
const preview = ref<{ files: Entry[]; start: number } | null>(null);
function open(e: Entry) {
  if (e.type === 'directory') { void router.push(folderRoute(source.value, e.path)); return; }
  const set = view.value === 'gallery' && isImage(e) ? files.value.filter(isImage) : files.value;
  preview.value = { files: set, start: set.findIndex((f) => f.path === e.path) };
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
const addMenu = ref<InstanceType<typeof ItemMenu>>();
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
watch(() => folder.loading, async (loading) => {
  const from = refocus;
  if (loading || !from || folder.path !== path.value || folder.source !== source.value) return;
  refocus = null;
  if (typeof route.query.select === 'string') return; // applySelect focuses the item asked for
  await nextTick();
  if (document.activeElement !== content.value && document.activeElement !== document.body) return; // moved on meanwhile
  const dir = folder.path === '/' ? '/' : folder.path + '/';
  const child = from.source === folder.source && from.path.startsWith(dir) ? join(folder.path, from.path.slice(dir.length).split('/')[0]!) : null;
  const target = folder.error ? undefined : entries.value.find((e) => e.path === child) ?? entries.value[0];
  if (target) (view.value === 'gallery' ? gallery.value : list.value)?.focusPath(target.path);
  else content.value?.focus();
});
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
  void favourites.load(); // moves and deletes carry favourites along on the server (#155)
  if (at.dir === folder.path && at.source === folder.source) await folder.open(at.dir, { refresh: true });
  await nextTick();
  if (!conflict.value && !renaming.value && (document.activeElement === document.body || !document.activeElement)) {
    (view.value === 'gallery' ? gallery.value : list.value)?.focus();
  }
}

// Uploads run in the uploads store (resumable, one panel); failures are summarised there, so this only reports the
// batch in a toast and relists once it has an outcome.
function upload(files: PickedFile[]) {
  const at = { source: folder.source, dir: folder.path }; // captured: navigating away mid-batch must not redirect the remaining files
  failures.value = null;
  uploads.enqueue(files, at, { returnFocus: uploadFocus(), settled: (r) => {
    say(r.skipped ? t('upload.summarySkipped', { done: r.done, total: r.total, skipped: r.skipped })
      : t('upload.summary', { done: r.done, total: r.total }), r.failed ? 'error' : 'success');
    void settle(at);
  } });
}

// Files and folders dragged in from the desktop upload into the open folder.
const dropActive = ref(false);
function onFileDragOver(e: DragEvent) { if (canUpload.value && acceptFileDrag(e)) dropActive.value = true; }
function onFileDragLeave(e: DragEvent) {
  if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) dropActive.value = false;
}
async function onFileDrop(e: DragEvent) {
  dropActive.value = false;
  if (!canUpload.value) return;
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
    say(r.skipped ? t(`transfer.${op}SummarySkipped`, { done: r.done, total: todo.length, skipped: r.skipped })
      : t(`transfer.${op}Summary`, { done: r.done, total: todo.length }), r.failed.length ? 'error' : 'success');
    return r;
  } finally {
    await settle(at);
  }
}

// A trash or paste in flight (#230): their buttons are disabled and a second click (a double click) sends nothing.
const acting = ref(false);
async function trash(entries: Entry[]) {
  if (acting.value) return;
  acting.value = true;
  const at = { source: folder.source, dir: folder.path };
  failures.value = null;
  try {
    await folder.trash(at.source, entries.map((e) => e.path));
    say(t('transfer.trashed', { count: entries.length }, entries.length));
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    toast.value = null;
    failures.value = { heading: t('transfer.failedHeading'), items: [t(`errors.${e.code}`)] };
  } finally {
    await settle(at);
    acting.value = false;
  }
}

// "New folder" (#221), wherever the caller may upload. A refusal (a taken name) stays in the dialog; the new folder is
// selected and focused, which scrolls it into view.
const creating = ref<{ error: string | null; busy: boolean } | null>(null);
async function createFolder(name: string) {
  const c = creating.value!;
  c.error = null; c.busy = true;
  const at = { source: folder.source, dir: folder.path };
  let created: Entry;
  try {
    created = await folder.mkdir(name);
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    c.error = t(`errors.${e.code}`); c.busy = false;
    return;
  }
  creating.value = null;
  failures.value = null;
  say(t('folder.created', { name: created.name }));
  if (at.source !== folder.source || at.dir !== folder.path) return;
  selected.value = [created.path];
  await nextTick(); // after AppDialog restored focus to where the dialog was opened
  (view.value === 'gallery' ? gallery.value : list.value)?.focusPath(created.path);
}
// The phone toolbar's Upload menu (#245): the toolbar's own two pickers and "New folder".
const addItems = computed<MenuItem[]>(() => [
  { id: 'files', label: t('upload.files') },
  { id: 'folder', label: t('upload.folderButton') },
  { id: 'mkdir', label: t('folder.newFolder') },
]);
// A dialog opened by an upload returns to the upload control the member can see: the file input of the desktop's
// "Upload", or on the phone the menu button that stands in for it.
function uploadFocus(): HTMLElement | undefined {
  const input = uploadButton.value?.input;
  return input?.parentElement?.checkVisibility() ? input : addMenu.value?.trigger ?? input;
}
function onAdd(id: string) {
  if (id === 'files') uploadButton.value!.input!.click();
  else if (id === 'folder') uploadButton.value!.folderInput!.click();
  else creating.value = { error: null, busy: false };
}
// Shift+N opens it, except while typing or while another dialog is open (as "?" does in App.vue).
function onKey(e: KeyboardEvent) {
  if (e.key !== 'N' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.repeat || !canUpload.value || creating.value) return;
  const at = e.target instanceof HTMLElement ? e.target : null;
  if (at?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  if (document.querySelector('[aria-modal="true"]')) return;
  e.preventDefault();
  creating.value = { error: null, busy: false };
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));

// Rename (#230) is one request of its own, not a move batch: a refusal (a taken name, a name the server rejects, no
// connection) stays inline in the dialog with the typed name, and the dialog holds its button while the request runs.
const renaming = ref<{ entry: Entry; error: string | null; busy: boolean } | null>(null);
async function rename(name: string) {
  const r = renaming.value!;
  const e = r.entry;
  if (name === e.name) { renaming.value = null; return; }
  r.error = null; r.busy = true;
  const at = { source: folder.source, dir: folder.path };
  let placed: Entry;
  try {
    placed = await folder.transfer('move', at.source, e.path, join(parentOf(e.path), name), 'fail');
  } catch (err) {
    if (!(err instanceof ApiFailure)) throw err;
    r.error = t('rename.failed', { reason: t(`errors.${err.code}`) }); r.busy = false;
    return;
  }
  renaming.value = null;
  failures.value = null;
  say(t('transfer.renamed', { name: placed.name }));
  await settle(at);
}

// Tags (#212): the chips of this folder's items come with every listing; "Add tag" puts one tag on the whole selection
// (all or nothing), and a refusal stays in the dialog with the typed name.
const tagStore = useTagsStore();
watch(() => folder.entries, () => { if (!folder.error) void tagStore.loadFolder(folder.source, folder.path); });
const folderTags = computed(() => tagStore.folder.source === source.value && tagStore.folder.path === path.value
  ? tagStore.folder.byPath : {});
const tagging = ref<{ entries: Entry[]; error: string | null; busy: boolean } | null>(null);
// Comments (#213): the badges of this folder's items come with every listing; the drawer's thread keeps them current.
const commentStore = useCommentsStore();
watch(() => folder.entries, () => { if (!folder.error) void commentStore.loadFolder(folder.source, folder.path); });
const folderComments = computed(() => commentStore.folder.source === source.value && commentStore.folder.path === path.value
  ? commentStore.folder.byPath : {});
async function addTag(name: string) {
  const g = tagging.value!;
  g.error = null; g.busy = true;
  try {
    await tagStore.add(folder.source, g.entries.map((e) => e.path), name);
  } catch (err) {
    if (!(err instanceof ApiFailure)) throw err;
    g.error = t(`errors.${err.code}`, err.params ?? {}); g.busy = false;
    return;
  }
  tagging.value = null;
  failures.value = null;
  say(t('tags.added', { tag: name, count: g.entries.length }, g.entries.length));
}

// The server sends an attachment; a link with `download` keeps the page even if the request fails.
function download(entries: Entry[]) {
  const a = document.createElement('a');
  a.href = downloadHref(folder.source, entries);
  a.download = '';
  a.click();
}

const starred = computed(() => favourites.items.filter((f) => f.source === source.value).map((f) => f.path));
// Stars or unstars one item of this source (#155); a toast says which.
async function toggleFavourite(e: Entry) {
  failures.value = null;
  try {
    const now = await favourites.toggle(source.value, e.path);
    say(t(now ? 'favourites.added' : 'favourites.removed', { name: e.name }));
  } catch (err) {
    if (!(err instanceof ApiFailure)) throw err;
    toast.value = null;
    failures.value = { heading: t('favourites.failedHeading'), items: [t(`errors.${err.code}`)] };
  }
}

function onAction(action: ItemAction, entries: Entry[]) {
  if (action === 'download') download(entries);
  else if (action === 'favourite') void toggleFavourite(entries[0]!);
  else if (action === 'share') sharing.value = entries[0]!;
  else if (action === 'details') details.value = entries[0]!;
  else if (action === 'rename') renaming.value = { entry: entries[0]!, error: null, busy: false };
  else if (action === 'trash') void trash(entries);
  else {
    const mode = action === 'cut' ? 'move' : 'copy';
    folder.clipboard = { mode, source: folder.source, entries };
    say(t(mode === 'move' ? 'transfer.markedMove' : 'transfer.markedCopy', { count: entries.length }, entries.length));
  }
}
// Within one source items move and copy directly; from another source they become a transfer job (#152).
const canPaste = computed(() => editable.value && folder.clipboard !== null);
async function paste() {
  const clip = folder.clipboard;
  if (!clip || !canPaste.value || acting.value) return;
  if (clip.mode === 'move') folder.clipboard = null; // a moved item is gone from where it was marked
  acting.value = true;
  try {
    if (clip.source !== folder.source) await pasteAcross(clip);
    else await transfer(clip.mode, clip.entries.map((e) => ({ from: e.path, name: e.name })), folder.path, clip.source);
  } finally {
    acting.value = false;
  }
}
// The open folder's listing tells which names are taken; each one asks the collision question before the job starts, so
// the job runs without asking. The job reports in the transfer panel; this folder relists once it has ended.
async function pasteAcross(clip: NonNullable<typeof folder.clipboard>) {
  const at = { source: folder.source, dir: folder.path };
  failures.value = null;
  const taken = new Set(folder.entries.map((e) => e.name));
  const items: { path: string; onCollision: CollisionPolicy }[] = [];
  let forAll: CollisionChoice['policy'] | null = null; // "apply to all remaining"
  for (const [i, e] of clip.entries.entries()) {
    if (!taken.has(e.name)) { items.push({ path: e.path, onCollision: 'fail' }); continue; }
    let policy = forAll;
    if (!policy) {
      const c = await ask(e.name, clip.entries.length - i - 1);
      policy = c.policy; if (c.all) forAll = c.policy;
    }
    if (policy !== 'skip') items.push({ path: e.path, onCollision: policy });
  }
  if (!items.length) { say(t('transfers.nothingToDo')); return; }
  try {
    await transfers.start({ mode: clip.mode, from: clip.source, to: at.source, dir: at.dir, items });
    say(t(`transfers.started.${clip.mode}`, items.length));
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    toast.value = null;
    failures.value = { heading: t('transfer.failedHeading'), items: [t(`errors.${e.code}`)] };
  }
}
watch(() => transfers.lastSettled, (j) => {
  if (!j) return;
  const here = (j.to === folder.source && j.dir === folder.path) || (j.mode === 'move' && j.from === folder.source);
  if (here && folder.source === source.value) void folder.open(folder.path, { refresh: true });
});
function onDrop(paths: string[], dir: string) {
  if (!editable.value) return;
  void transfer('move', paths.map((p) => ({ from: p, name: baseName(p) })), dir);
}
</script>

<template>
  <section
    ref="section"
    class="page folder"
    :class="{ 'drop-active': dropActive }"
    :style="{ '--selection-bar-height': `${selectionBarHeight}px` }"
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
    <div
      v-if="!folder.error"
      class="toolbar"
    >
      <Breadcrumbs
        :source="source"
        :path="path"
        :root-label="rootLabel"
        :root-note="rootNote"
        :editable="editable"
        @drop="onDrop"
      />
      <div class="toolbar-actions">
        <select
          class="fs-input sort-menu"
          :class="{ 'with-headers': view === 'list' }"
          :aria-label="$t('sort.label')"
          :value="`${sort.key}-${sort.dir}`"
          @change="onSortMenu"
        >
          <option
            v-for="o in SORT_OPTIONS"
            :key="o"
            :value="o"
          >
            {{ $t(`sort.${o}`) }}
          </option>
        </select>
        <div
          class="segmented view-toggle"
          role="group"
          :aria-label="$t('view.label')"
        >
          <button
            v-for="v in (['list', 'gallery'] as const)"
            :key="v"
            type="button"
            class="segment"
            :aria-label="$t(`view.${v}`)"
            :aria-pressed="view === v"
            @click="setView(v)"
          >
            <span
              class="icon"
              :class="`icon-view-${v}`"
              aria-hidden="true"
            />
            <span class="segment-text">{{ $t(`view.${v}`) }}</span>
          </button>
        </div>
        <button
          v-if="canUpload"
          type="button"
          class="button new-folder-button"
          @click="creating = { error: null, busy: false }"
        >
          {{ $t('folder.newFolder') }}
        </button>
        <UploadButton
          v-if="canUpload"
          ref="uploadButton"
          @files="upload"
        />
        <!-- On the phone this menu stands in for the three buttons above, so the toolbar keeps one row (#245). -->
        <ItemMenu
          v-if="canUpload"
          ref="addMenu"
          class="add-menu"
          :label="$t('upload.button')"
          :text="$t('upload.button')"
          :items="addItems"
          @select="onAdd"
        />
      </div>
      <!-- While a selection exists the bar takes the place of the toolbar's actions (#239), so the list never moves. -->
      <div
        v-if="selectedEntries.length || canPaste"
        ref="selectionBar"
        class="selection-bar"
        role="group"
        :aria-label="$t('actions.toolbar')"
      >
        <span
          v-if="selectedEntries.length"
          class="selection-count"
        >{{ $t('actions.selected', { count: selectedEntries.length }) }}</span>
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
              class="button tag-button"
              :aria-label="$t('tags.addToSelection')"
              :title="$t('tags.addToSelection')"
              @click="tagging = { entries: selectedEntries, error: null, busy: false }"
            >
              <span
                class="icon icon-tag"
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              class="button danger"
              :disabled="acting"
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
            :disabled="acting"
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
    </div>
    <!-- The upload panel sits under the toolbar here, so the title stays put when an upload starts (#239). -->
    <UploadPanel />
    <CollisionDialog
      v-if="conflict"
      :name="conflict.name"
      :remaining="conflict.remaining"
      :return-focus="conflict.returnFocus"
      @choose="conflict.answer"
    />
    <RenameDialog
      v-if="renaming"
      :name="renaming.entry.name"
      :is-folder="renaming.entry.type === 'directory'"
      :error="renaming.error"
      :busy="renaming.busy"
      @submit="rename"
      @cancel="renaming = null"
    />
    <NewFolderDialog
      v-if="creating"
      :error="creating.error"
      :busy="creating.busy"
      @submit="createFolder"
      @cancel="creating = null"
    />
    <AddTagDialog
      v-if="tagging"
      :count="tagging.entries.length"
      :error="tagging.error"
      :busy="tagging.busy"
      @submit="addTag"
      @cancel="tagging = null"
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
      :root-label="rootLabel"
      @close="details = null"
      @share="shareFromDetails"
      @restored="folder.open(folder.path, { refresh: true })"
    />
    <PreviewDialog
      v-if="preview"
      :files="preview.files"
      :start="preview.start"
      :source="source"
      @close="closePreview"
    />
    <ActionToast
      :toast="toast"
      @dismiss="toast = null"
    />
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
    <div
      ref="content"
      class="folder-content"
      role="region"
      tabindex="-1"
      :aria-label="$t('a11y.folderContent', { folder: folderName })"
      :aria-busy="folder.loading"
    >
      <p
        v-if="folder.loading && !skeleton"
        class="folder-loading"
      >
        {{ $t('folder.loading') }}
      </p>
      <div
        class="folder-items"
        :inert="folder.loading && !skeleton"
      >
        <StateAlert
          v-if="folder.error"
          :title="$t(notFound ? 'folder.notFound' : 'folder.failed')"
          :text="$t(notFound ? 'folder.notFoundText' : `errors.${folder.error.code}`)"
        >
          <RouterLink
            v-if="notFound"
            class="button primary"
            to="/home"
          >
            {{ $t('nav.toHome') }}
          </RouterLink>
          <button
            v-else
            type="button"
            class="button primary"
            @click="folder.open(path, { source })"
          >
            {{ $t('app.retry') }}
          </button>
        </StateAlert>
        <RowSkeleton v-else-if="skeleton" />
        <div
          v-else-if="folder.entries.length === 0 && !folder.loading"
          class="empty-state"
        >
          <span
            class="icon"
            :class="atHome ? 'icon-upload' : 'icon-folder'"
            aria-hidden="true"
          />
          <p>{{ $t(atHome ? 'folder.emptyHome' : 'folder.empty') }}</p>
          <!-- The toolbar's file picker, so an upload from here is the same upload. -->
          <button
            v-if="canUpload"
            type="button"
            class="button primary"
            @click="uploadButton?.input?.click()"
          >
            {{ $t('upload.button') }}
          </button>
        </div>
        <GalleryGrid
          v-else-if="view === 'gallery'"
          ref="gallery"
          v-model:selected="selected"
          :entries="entries"
          :folder-name="folderName"
          :source="source"
          :editable="editable"
          :shareable="shareable"
          :starred="starred"
          :tags="folderTags"
          @open="open"
          @action="onAction"
          @paste="paste"
        />
        <!-- The comment badges (#213) are only in the list, where each row has room for them. -->
        <FileList
          v-else
          ref="list"
          v-model:selected="selected"
          :entries="entries"
          :sort="sort"
          :folder-name="folderName"
          :source="source"
          :editable="editable"
          :shareable="shareable"
          :starred="starred"
          :tags="folderTags"
          :comments="folderComments"
          @open="open"
          @action="onAction"
          @paste="paste"
          @drop="onDrop"
          @sort="sortBy"
        />
      </div>
    </div>
  </section>
</template>
