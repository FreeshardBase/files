<script setup lang="ts">
// The duplicate finder (#216): pick where to look (My storage and the member's cloud accounts), search, follow the
// progress or cancel, then review the groups of identical files with thumbnail, name, place and date. The member picks
// copies to move to the trash; "keep the oldest" and "keep the newest" only pick for them, and one copy of a group can
// never be picked. The server checks every picked copy again before it goes to the trash, and keeps one that changed.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DuplicateCopy, DuplicateGroup } from '@files/shared';
import { useDuplicatesStore } from '../stores/duplicates.ts';
import { useConnectionsStore } from '../stores/connections.ts';
import { ApiFailure } from '../api/client.ts';
import { formatDate, formatSize, intlLocale } from '../format.ts';
import { hasThumbnail, thumbnailHref } from '../preview.ts';
import { parentOf, useLocations } from '../location.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import ActionToast, { type Toast } from '../components/ActionToast.vue';

const { t, locale } = useI18n();
const store = useDuplicatesStore();
const connections = useConnectionsStore();
const { sourceName, folderLabel } = useLocations();

const SCAN_MAX_FILES = 200_000;
const POLL_MS = 500;
const sources = ref<string[]>(['home']);
const offered = computed(() => ['home', ...connections.items.filter((c) => c.status === 'ok').map((c) => c.source)]);
const sourceLabel = (s: string) => {
  const c = connections.bySource(s);
  return c ? t('nav.connection', { provider: c.providerName, account: c.account }) : sourceName(s);
};

const failure = ref<string | null>(null);
const toast = ref<Toast | null>(null);
let toastId = 0;
const kept = ref<string[]>([]);
let timer: ReturnType<typeof setTimeout> | undefined;
let alive = true;
// While a scan runs its progress is asked for twice a second; the page stops asking once it has ended or is left.
async function poll() {
  clearTimeout(timer);
  try {
    await store.load();
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    failure.value = t(`errors.${e.code}`);
    return;
  }
  if (alive && store.scan?.status === 'running') timer = setTimeout(() => { void poll(); }, POLL_MS);
}
onMounted(() => { void poll(); });
onUnmounted(() => { alive = false; clearTimeout(timer); });

const scan = computed(() => store.scan);
const running = computed(() => scan.value?.status === 'running');
const groups = computed<DuplicateGroup[]>(() => (scan.value?.status === 'completed' ? scan.value.groups : []));
const percent = computed(() => {
  const s = scan.value!;
  return s.candidates === 0 ? 0 : Math.min(99, Math.floor((s.hashed / s.candidates) * 100));
});
const progressText = computed(() => {
  const s = scan.value!;
  return s.candidates === 0 && s.hashed === 0 ? t('duplicates.listing', { files: s.files })
    : t('duplicates.hashing', { hashed: s.hashed, candidates: s.candidates });
});

async function start() {
  failure.value = null; kept.value = []; picked.value = new Set();
  try { await store.start(sources.value); }
  catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    failure.value = t(`errors.${e.code}`);
    return;
  }
  void poll();
}
async function cancel() {
  try { await store.cancel(); }
  catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    failure.value = t(`errors.${e.code}`);
  }
}

// The picked copies, by source and path.
const keyOf = (c: DuplicateCopy) => `${c.source}\n${c.path}`;
const picked = ref(new Set<string>());
const isPicked = (c: DuplicateCopy) => picked.value.has(keyOf(c));
// The last copy of a group that is not picked cannot be picked: one always stays.
const locked = (g: DuplicateGroup, c: DuplicateCopy) => !isPicked(c) && g.copies.filter((o) => !isPicked(o)).length <= 1;
function toggle(c: DuplicateCopy) {
  const next = new Set(picked.value);
  if (next.has(keyOf(c))) next.delete(keyOf(c)); else next.add(keyOf(c));
  picked.value = next;
}
// Suggestions only pick; the member can change every box afterwards. Copies come oldest first.
function keep(which: 'oldest' | 'newest') {
  const next = new Set<string>();
  for (const g of groups.value) {
    const stays = which === 'oldest' ? 0 : g.copies.length - 1;
    g.copies.forEach((c, i) => { if (i !== stays) next.add(keyOf(c)); });
  }
  picked.value = next;
}
const pickedCopies = computed(() => groups.value.flatMap((g) => g.copies.filter(isPicked)));

const confirming = ref(false);
const busy = ref(false);
async function trash() {
  confirming.value = false;
  if (busy.value) return;
  busy.value = true;
  failure.value = null; kept.value = [];
  const items = pickedCopies.value.map((c) => ({ source: c.source, path: c.path }));
  try {
    const r = await store.trash(items);
    const done = r.results.filter((x) => x.trashed).length;
    kept.value = r.results.filter((x) => !x.trashed)
      .map((x) => t('duplicates.keptItem', { path: folderLabel(x.source, x.path), reason: t(`errors.${x.code ?? 'INTERNAL'}`) }));
    toast.value = { text: t('duplicates.trashed', { count: done }, done), kind: kept.value.length ? 'error' : 'success', id: ++toastId };
    picked.value = new Set();
  } catch (e) {
    if (!(e instanceof ApiFailure)) throw e;
    failure.value = t(`errors.${e.code}`);
  } finally {
    busy.value = false;
  }
}

const size = (n: number) => formatSize(n, intlLocale(locale.value));
const date = (iso: string) => formatDate(iso, intlLocale(locale.value));
const place = (c: DuplicateCopy) => folderLabel(c.source, parentOf(c.path));
</script>

<template>
  <section class="page recent duplicates">
    <div class="toolbar">
      <h1
        class="view-title"
        tabindex="-1"
      >
        {{ $t('duplicates.title') }}
      </h1>
    </div>
    <p class="duplicates-note">
      {{ $t('duplicates.intro') }}
    </p>
    <fieldset
      class="duplicates-sources"
      :disabled="running"
    >
      <legend class="fs-label">
        {{ $t('duplicates.where') }}
      </legend>
      <label
        v-for="s in offered"
        :key="s"
        class="migrate-radio"
      >
        <input
          v-model="sources"
          type="checkbox"
          :value="s"
        >
        {{ sourceLabel(s) }}
      </label>
    </fieldset>
    <p
      v-if="offered.length > 1"
      class="duplicates-note"
    >
      {{ $t('duplicates.cloudNote') }}
    </p>
    <div class="duplicates-actions">
      <button
        v-if="!running"
        type="button"
        class="button primary"
        :disabled="sources.length === 0 || scan === null"
        @click="start"
      >
        {{ $t(scan && scan.status !== 'idle' ? 'duplicates.again' : 'duplicates.start') }}
      </button>
      <button
        v-else
        type="button"
        class="button danger"
        @click="cancel"
      >
        {{ $t('duplicates.cancel') }}
      </button>
    </div>
    <p
      v-if="failure"
      role="alert"
      class="fs-field__error"
    >
      {{ failure }}
    </p>
    <div
      v-if="scan && running"
      class="duplicates-progress"
    >
      <p role="status">
        {{ progressText }}
      </p>
      <div
        class="upload-bar"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="percent"
        :aria-label="$t('duplicates.progressLabel')"
      >
        <span :style="{ width: `${percent}%` }" />
      </div>
    </div>
    <p
      v-else-if="scan?.status === 'cancelled'"
      role="status"
    >
      {{ $t('duplicates.cancelled') }}
    </p>
    <template v-else-if="scan?.status === 'completed'">
      <p role="status">
        {{ groups.length ? $t('duplicates.found', { count: groups.length }, groups.length) : $t('duplicates.none') }}
      </p>
      <p
        v-if="!scan.complete"
        class="duplicates-note"
      >
        {{ $t('duplicates.incomplete', { max: SCAN_MAX_FILES }) }}
      </p>
      <p
        v-if="scan.unhashed"
        class="duplicates-note"
      >
        {{ $t('duplicates.unhashed', { count: scan.unhashed }, scan.unhashed) }}
      </p>
      <ul
        v-if="scan.failed.length"
        class="transfer-failures"
      >
        <li
          v-for="f in scan.failed"
          :key="f.source"
        >
          {{ $t('duplicates.failedSource', { source: sourceLabel(f.source), reason: $t(`errors.${f.code}`) }) }}
        </li>
      </ul>
      <div
        v-if="groups.length"
        class="duplicates-actions"
      >
        <button
          type="button"
          class="button"
          @click="keep('oldest')"
        >
          {{ $t('duplicates.keepOldest') }}
        </button>
        <button
          type="button"
          class="button"
          @click="keep('newest')"
        >
          {{ $t('duplicates.keepNewest') }}
        </button>
        <button
          type="button"
          class="button"
          :disabled="pickedCopies.length === 0"
          @click="picked = new Set()"
        >
          {{ $t('duplicates.clear') }}
        </button>
        <button
          type="button"
          class="button danger"
          :disabled="pickedCopies.length === 0 || busy"
          @click="confirming = true"
        >
          {{ $t('duplicates.trash', { count: pickedCopies.length }, pickedCopies.length) }}
        </button>
      </div>
      <div
        v-if="kept.length"
        class="upload-failures"
      >
        <p>{{ $t('duplicates.keptHeading') }}</p>
        <ul>
          <li
            v-for="(k, i) in kept"
            :key="i"
          >
            {{ k }}
          </li>
        </ul>
      </div>
      <section
        v-for="g in groups"
        :key="g.id"
        class="duplicate-group"
        :aria-label="$t('duplicates.groupTitle', { count: g.copies.length, size: size(g.size) })"
      >
        <h2>{{ $t('duplicates.groupTitle', { count: g.copies.length, size: size(g.size) }) }}</h2>
        <div
          v-for="c in g.copies"
          :key="`${c.source}:${c.path}`"
          class="duplicate-copy"
        >
          <input
            type="checkbox"
            :checked="isPicked(c)"
            :disabled="locked(g, c)"
            :title="locked(g, c) ? $t('duplicates.oneStays') : undefined"
            :aria-label="$t('duplicates.pick', { name: c.name, location: place(c) })"
            @change="toggle(c)"
          >
          <span
            class="duplicate-thumb"
            aria-hidden="true"
          >
            <img
              v-if="hasThumbnail({ type: 'file', mime: c.mime })"
              :src="thumbnailHref(c.source, c, 128)"
              alt=""
              loading="lazy"
            >
            <span
              v-else
              class="icon icon-file"
            />
          </span>
          <span class="duplicate-info">
            <span class="name">{{ c.name }}</span>
            <span class="origin">{{ place(c) }}</span>
            <span
              v-if="c.modified"
              class="origin"
            >{{ $t('duplicates.modified', { date: date(c.modified) }) }}</span>
          </span>
        </div>
      </section>
    </template>
    <ConfirmDialog
      v-if="confirming"
      :title="$t('duplicates.confirmTitle')"
      :message="$t('duplicates.confirmText', { count: pickedCopies.length }, pickedCopies.length)"
      :confirm-label="$t('duplicates.confirm')"
      @confirm="trash"
      @cancel="confirming = false"
    />
    <ActionToast
      :toast="toast"
      @dismiss="toast = null"
    />
  </section>
</template>
