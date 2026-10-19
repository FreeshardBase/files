<script setup lang="ts">
// "Move to…" / "Copy to…" (#339): a folder picker across every place the member may change: the home, each cloud
// connection and the shares with edit access. The top level lists them, the last used target first; inside a place the
// subfolders come page by page. The folder the items are in and the selected folders (so everything below them too) are
// no target. "New folder" creates one where the picker is and opens it. Choosing emits the target with its listing's name
// rules; the folder pane runs the move or copy. A bottom sheet on the phone, like every dialog.
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Access, Entry, ListResponse, NameRuleSet } from '@files/shared';
import AppDialog from './AppDialog.vue';
import { api, ApiFailure } from '../api/client.ts';
import { sourceApi } from '../api/paths.ts';
import { join } from '../stores/folder.ts';
import { useConnectionsStore } from '../stores/connections.ts';
import { useSharedStore } from '../stores/shared.ts';
import { useSessionStore } from '../stores/session.ts';
import { useWorkspaceStore } from '../stores/workspace.ts';
import { joinLocation, useLocations } from '../location.ts';
import { lastTarget, rememberTarget, type Target } from '../moveTarget.ts';

// `source`, `dir`: where the items are; `entries`: the items.
const props = defineProps<{ mode: 'move' | 'copy'; source: string; dir: string; entries: Entry[]; returnFocus?: HTMLElement | null }>();
const emit = defineEmits<{ choose: [Target & { nameRules: NameRuleSet }]; cancel: [] }>();
const { t } = useI18n();
const connections = useConnectionsStore();
const shared = useSharedStore();
const session = useSessionStore();
const workspace = useWorkspaceStore();
const { sourceName } = useLocations();
const member = computed(() => session.me?.id ?? '');
onMounted(() => {
  void shared.load();
  if (!connections.loaded) void connections.load();
});

const places = computed(() => [
  { source: 'home', label: t('nav.home'), note: '' },
  ...connections.items.filter((c) => c.status === 'ok').map((c) => ({ source: c.source, label: c.providerName, note: c.account })),
  ...shared.items.filter((s) => s.access === 'edit' && s.type === 'directory' && !s.orphaned)
    .map((s) => ({ source: s.source, label: s.name, note: s.owner.displayName })),
]);
const rootLabel = (source: string) => places.value.find((p) => p.source === source)?.label ?? sourceName(source);
// The last target, while its place is still one of them.
const last = computed(() => {
  const l = member.value ? lastTarget(member.value) : null;
  return l && places.value.some((p) => p.source === l.source) ? l : null;
});

// Where the picker is: null is the top level (the places).
const at = ref<Target | null>(null);
const folders = ref<Entry[]>([]);
const next = ref<string | undefined>();
const access = ref<Access>('read');
const nameRules = ref<NameRuleSet>('universal');
const loading = ref(false);
const error = ref('');
let seq = 0; // only the newest listing may touch the state

async function fetchPage(cursor?: string) {
  const here = at.value!;
  const id = ++seq;
  loading.value = true; error.value = '';
  try {
    const page = await api.get<ListResponse>(`${sourceApi(here.source)}/list`, cursor ? { path: here.path, cursor } : { path: here.path });
    if (id !== seq) return;
    const dirs = page.entries.filter((e) => e.type === 'directory');
    folders.value = cursor ? [...folders.value, ...dirs] : dirs;
    next.value = page.next; access.value = page.access; nameRules.value = page.nameRules;
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    if (id === seq) { error.value = t(`errors.${e.code}`); if (!cursor) { folders.value = []; next.value = undefined; } }
  } finally {
    if (id === seq) loading.value = false;
  }
}
// The button that opened the place or folder leaves the DOM; the focus goes to the current crumb (#356), as the
// migration wizard moves it to the new step.
const crumbNav = ref<HTMLElement>();
async function go(target: Target | null) {
  at.value = target; folders.value = []; next.value = undefined; access.value = 'read'; error.value = ''; creating.value = null;
  if (target) void fetchPage();
  else { seq++; loading.value = false; }
  await nextTick();
  crumbNav.value?.querySelector<HTMLElement>('[aria-current="location"]')?.focus();
}

const crumbs = computed(() => {
  const top = { label: t('moveTo.places'), target: null as Target | null };
  if (!at.value) return [top];
  const { source } = at.value;
  const segs = at.value.path.split('/').filter(Boolean);
  return [top, { label: rootLabel(source), target: { source, path: '/' } },
    ...segs.map((s, i) => ({ label: s, target: { source, path: '/' + segs.slice(0, i + 1).join('/') } }))];
});

// The selected folders and everything below them; the folder the items are in is no target either, but may be opened.
const selectedDirs = computed(() => props.entries.filter((e) => e.type === 'directory').map((e) => e.path));
const within = (path: string, dir: string) => path === dir || path.startsWith(dir + '/');
const isSelected = (source: string, path: string) => source === props.source && selectedDirs.value.some((d) => within(path, d));
const blocked = computed(() => !!at.value && (isSelected(at.value.source, at.value.path)
  || (at.value.source === props.source && at.value.path === props.dir)));
const canChoose = computed(() => !!at.value && !loading.value && !error.value && access.value === 'edit' && !blocked.value);
const hint = computed(() => {
  if (!at.value || loading.value || error.value) return at.value ? '' : t('moveTo.choosePlace');
  if (blocked.value) return t('moveTo.blocked');
  return access.value === 'edit' ? '' : t('moveTo.readOnly');
});

function choose() {
  if (!canChoose.value) return;
  const target = { source: at.value!.source, path: at.value!.path };
  if (member.value) rememberTarget(member.value, target);
  emit('choose', { ...target, nameRules: nameRules.value });
}

// "New folder" inside the picker: created where the picker is, then opened.
const creating = ref<{ name: string; error: string | null; busy: boolean } | null>(null);
const newName = ref<HTMLInputElement>();
const formId = useId();
async function startCreating() {
  creating.value = { name: '', error: null, busy: false };
  await nextTick();
  newName.value?.focus();
}
const errorId = useId();
async function createFolder() {
  const c = creating.value!;
  const here = at.value!;
  const name = c.name.trim();
  if (!name || c.busy) return;
  c.error = null; c.busy = true;
  let created: Entry;
  try {
    created = await api.post<Entry>(`${sourceApi(here.source)}/mkdir`, { path: join(here.path, name) });
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    c.error = t(`errors.${e.code}`); c.busy = false;
    return;
  }
  workspace.touch('move-to', here.source, [here.path]); // a pane showing that folder relists
  if (at.value === here) await go({ source: here.source, path: created.path });
}
</script>

<template>
  <AppDialog
    :title="t(mode === 'move' ? 'actions.moveTo' : 'actions.copyTo')"
    :return-focus="returnFocus"
    @close="emit('cancel')"
  >
    <nav
      ref="crumbNav"
      class="breadcrumbs picker-crumbs move-to-crumbs"
      :aria-label="t('moveTo.path')"
    >
      <template
        v-for="(c, i) in crumbs"
        :key="i"
      >
        <span
          v-if="i > 0"
          class="sep"
          aria-hidden="true"
        >/</span>
        <button
          type="button"
          class="crumb"
          :aria-current="i === crumbs.length - 1 ? 'location' : undefined"
          @click="go(c.target)"
        >
          {{ c.label }}
        </button>
      </template>
    </nav>
    <ul
      v-if="!at"
      class="picker-list move-to-list"
    >
      <li v-if="last">
        <button
          type="button"
          class="picker-folder"
          @click="go(last)"
        >
          <span
            class="icon icon-folder"
            aria-hidden="true"
          />
          <span>
            <span class="fs-label">{{ t('moveTo.lastUsed') }}</span>
            {{ joinLocation(rootLabel(last.source), last.path) }}
          </span>
        </button>
      </li>
      <li
        v-for="p in places"
        :key="p.source"
      >
        <button
          type="button"
          class="picker-folder"
          @click="go({ source: p.source, path: '/' })"
        >
          <span
            class="icon icon-folder"
            aria-hidden="true"
          />
          {{ p.label }}
          <span
            v-if="p.note"
            class="picker-note"
          >{{ p.note }}</span>
        </button>
      </li>
    </ul>
    <template v-else>
      <p
        v-if="error"
        role="alert"
      >
        {{ error }}
      </p>
      <p
        v-else-if="!loading && folders.length === 0 && !next"
        class="trash-note"
      >
        {{ t('migrate.noSubfolders') }}
      </p>
      <ul
        v-if="folders.length"
        class="picker-list move-to-list"
      >
        <li
          v-for="f in folders"
          :key="f.path"
        >
          <button
            type="button"
            class="picker-folder"
            :disabled="isSelected(at.source, f.path)"
            @click="go({ source: at.source, path: f.path })"
          >
            <span
              class="icon icon-folder"
              aria-hidden="true"
            />
            {{ f.name }}
          </button>
        </li>
      </ul>
      <p v-if="loading">
        {{ t('folder.loading') }}
      </p>
      <button
        v-else-if="next"
        type="button"
        class="button picker-more move-to-action"
        @click="fetchPage(next)"
      >
        {{ t('moveTo.more') }}
      </button>
      <form
        v-if="creating"
        :id="formId"
        class="app-dialog-form picker-new-folder"
        @submit.prevent="createFolder"
      >
        <label class="app-dialog-field">
          <span class="fs-label">{{ t('folder.newFolderLabel') }}</span>
          <input
            ref="newName"
            v-model="creating.name"
            class="fs-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :aria-invalid="creating.error !== null"
            :aria-describedby="creating.error !== null ? errorId : undefined"
          >
        </label>
        <p
          v-if="creating.error !== null"
          :id="errorId"
          class="fs-field__error"
        >
          {{ creating.error }}
        </p>
        <div class="picker-new-folder-actions">
          <button
            type="button"
            class="button move-to-action"
            @click="creating = null"
          >
            {{ t('folder.cancel') }}
          </button>
          <button
            type="submit"
            class="button move-to-action"
            :disabled="creating.busy || !creating.name.trim()"
          >
            {{ t('folder.create') }}
          </button>
        </div>
      </form>
    </template>
    <p
      v-if="hint"
      class="picker-hint"
    >
      {{ hint }}
    </p>
    <template #actions>
      <button
        v-if="at && access === 'edit' && !loading && !creating"
        type="button"
        class="button picker-new move-to-action"
        @click="startCreating"
      >
        {{ t('folder.newFolder') }}
      </button>
      <button
        type="button"
        class="button move-to-action"
        @click="emit('cancel')"
      >
        {{ t('folder.cancel') }}
      </button>
      <button
        type="button"
        class="button primary move-to-action"
        :disabled="!canChoose"
        @click="choose"
      >
        {{ t(mode === 'move' ? 'moveTo.moveHere' : 'moveTo.copyHere') }}
      </button>
    </template>
  </AppDialog>
</template>
