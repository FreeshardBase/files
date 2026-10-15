<script setup lang="ts">
// Name search in the header (#145): a combobox whose listbox groups the results by source (WAI-ARIA combobox pattern,
// focus stays in the field, the active option is aria-activedescendant). Enter or a click opens the folder that holds
// a file with the file selected, or a folder itself. A source that could not be searched is named under the results.
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { Entry } from '@files/shared';
import { useSearchStore } from '../stores/search.ts';
import { folderRoute } from '../api/paths.ts';
import { useConnectionsStore } from '../stores/connections.ts';

const DEBOUNCE_MS = 200;
const { t } = useI18n();
const router = useRouter();
const search = useSearchStore();
const text = ref('');
const open = ref(false); // the results area is shown (closed by Escape, a choice or leaving the field)
const active = ref(-1); // index into `flat`
let timer: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => clearTimeout(timer));

const connections = useConnectionsStore();
// A connection's group is named like its sidebar entry (#148).
const sourceLabel = (source: string) => {
  if (source === 'home') return t('nav.home');
  const c = connections.bySource(source);
  return c ? t('nav.connection', { provider: c.providerName, account: c.account }) : source;
};
const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const folderLabel = (source: string, p: string) => p === '/' ? sourceLabel(source) : p;

type Result = { source: string; entry: Entry; id: string };
// Groups with results, in the server's order (home first); every option has a stable id for aria-activedescendant.
const groups = computed(() => {
  let n = 0;
  return search.groups.filter((g) => g.items.length > 0)
    .map((g, gi) => ({ ...g, gi, results: g.items.map((entry): Result => ({ source: g.source, entry, id: `search-option-${n++}` })) }));
});
const flat = computed(() => groups.value.flatMap((g) => g.results));
const current = computed(() => search.query === text.value.trim() && !search.loading);
const failed = computed(() => search.groups.filter((g) => g.error));
const capped = computed(() => search.groups.filter((g) => g.more));
const showList = computed(() => open.value && flat.value.length > 0);
const showEmpty = computed(() => open.value && current.value && !search.error && flat.value.length === 0);

function onInput() {
  clearTimeout(timer);
  active.value = -1;
  const q = text.value.trim();
  if (!q) { search.clear(); open.value = false; return; }
  open.value = true;
  timer = setTimeout(() => { void search.search(q); }, DEBOUNCE_MS);
}

function choose(r: Result) {
  open.value = false; active.value = -1;
  const e = r.entry;
  void router.push(e.type === 'directory' ? folderRoute(r.source, e.path)
    : { path: folderRoute(r.source, parentOf(e.path)), query: { select: e.path } });
}

function move(by: number) {
  if (!open.value) { open.value = text.value.trim() !== ''; return; }
  const n = flat.value.length;
  if (n === 0) return;
  active.value = active.value < 0 ? (by > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, active.value + by));
  document.getElementById(flat.value[active.value]!.id)?.scrollIntoView({ block: 'nearest' });
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter') {
    // The active result, else the first one; nothing while the results are not those of the text typed.
    const r = flat.value[active.value] ?? (current.value ? flat.value[0] : undefined);
    if (open.value && r) { e.preventDefault(); choose(r); }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (open.value) { open.value = false; active.value = -1; }
    else { text.value = ''; onInput(); }
  }
}

const root = ref<HTMLElement>();
function onFocusOut(e: FocusEvent) {
  if (!root.value?.contains(e.relatedTarget as Node | null)) { open.value = false; active.value = -1; }
}
</script>

<template>
  <div
    ref="root"
    class="search"
    @focusout="onFocusOut"
  >
    <span
      class="icon icon-search"
      aria-hidden="true"
    />
    <input
      v-model="text"
      type="search"
      class="fs-input search-input"
      role="combobox"
      aria-autocomplete="list"
      aria-controls="search-results"
      :aria-expanded="showList"
      :aria-activedescendant="showList && active >= 0 ? flat[active]?.id : undefined"
      :aria-label="$t('search.label')"
      :placeholder="$t('search.placeholder')"
      autocomplete="off"
      spellcheck="false"
      enterkeyhint="search"
      maxlength="200"
      @input="onInput"
      @keydown="onKey"
      @focus="open = text.trim() !== ''"
    >
    <div
      v-if="open"
      class="search-popup"
    >
      <div
        v-show="showList"
        id="search-results"
        role="listbox"
        :aria-label="$t('search.results')"
      >
        <div
          v-for="g in groups"
          :key="g.source"
          role="group"
          :aria-labelledby="`search-group-${g.gi}`"
          class="search-group"
        >
          <div
            :id="`search-group-${g.gi}`"
            role="presentation"
            class="search-group-title"
          >
            {{ sourceLabel(g.source) }}
          </div>
          <div
            v-for="r in g.results"
            :id="r.id"
            :key="r.entry.path"
            role="option"
            class="search-option"
            :aria-selected="flat[active]?.id === r.id"
            @mousedown.prevent
            @click="choose(r)"
          >
            <span
              class="icon"
              :class="r.entry.type === 'directory' ? 'icon-folder' : 'icon-file'"
              aria-hidden="true"
            />
            <span class="search-name">{{ r.entry.name }}</span>
            <span class="search-location">{{ folderLabel(r.source, parentOf(r.entry.path)) }}</span>
          </div>
        </div>
      </div>
      <p
        v-if="search.loading && flat.length === 0"
        class="search-note"
      >
        {{ $t('search.searching') }}
      </p>
      <p
        v-if="showEmpty"
        class="search-note search-empty"
      >
        {{ $t('search.empty', { query: search.query }) }}
      </p>
      <p
        v-if="search.error"
        class="search-note search-error"
        role="alert"
      >
        {{ $t(`errors.${search.error.code}`) }}
      </p>
      <p
        v-for="g in failed"
        :key="`failed-${g.source}`"
        class="search-note search-error"
      >
        {{ $t('search.sourceFailed', { source: sourceLabel(g.source), reason: $t(`errors.${g.error!.code}`) }) }}
      </p>
      <p
        v-for="g in capped"
        :key="`more-${g.source}`"
        class="search-note"
      >
        {{ $t('search.more', { source: sourceLabel(g.source) }) }}
      </p>
    </div>
    <!-- A live region without role="status", so the folder view's status line stays the page's status. -->
    <p
      class="visually-hidden"
      aria-live="polite"
    >
      <template v-if="open && current && !search.error">
        {{ $t('search.count', { count: flat.length }, flat.length) }}
      </template>
    </p>
  </div>
</template>
