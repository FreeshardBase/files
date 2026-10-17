<script setup lang="ts">
// The folder view: one open folder (FolderPane), or the member's optional layouts: two panes side by side on a wide
// screen (#218) and tabs in each pane (#219). With both off it is the one pane alone, exactly as before.
// The address is always the focused pane's active tab: a navigation (a folder opened, a crumb, the sidebar, back and
// forward) moves that tab, and focusing another pane or tab puts its place in the address bar. Pressing or focusing
// anything in a pane focuses it, so every action (toolbar, keys, item menu) is that pane's.
// Tabs stay mounted while hidden, so each keeps its listing, selection and view; its scroll is put back when it shows.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import FolderPane from '../components/FolderPane.vue';
import { folderRoute } from '../api/paths.ts';
import { useFolderStore } from '../stores/folder.ts';
import { useLayoutStore } from '../stores/layout.ts';
import { useWorkspaceStore, type OtherPane, type Tab } from '../stores/workspace.ts';
import { useLocations } from '../location.ts';

type P = 0 | 1;
const route = useRoute(); const router = useRouter(); const { t } = useI18n();
const layout = useLayoutStore();
const ws = useWorkspaceStore();
const { sourceName } = useLocations();

// Two panes only on a wide screen; on a narrower one the setting is ignored and the first pane shows alone.
const WIDE = matchMedia('(min-width: 1100px)');
const wide = ref(WIDE.matches);
const onWide = () => { wide.value = WIDE.matches; };
WIDE.addEventListener('change', onWide);
onUnmounted(() => WIDE.removeEventListener('change', onWide));
const dual = computed(() => layout.dualPane && wide.value);
const plain = computed(() => !dual.value && !layout.tabs);
const shown = computed<P[]>(() => (dual.value ? [0, 1] : [0]));
const focusedPane = computed<P>(() => (dual.value ? ws.focused : 0));
const focusedTab = computed(() => ws.activeTab(focusedPane.value));

// The address moves the focused tab; `?select=` (a search result) is the focused tab's alone.
watch(() => [route.params.source, route.params.path], ([s, p]) => {
  if (typeof s !== 'string') return; // leaving the folder view
  const segs = Array.isArray(p) ? p : p ? [p] : [];
  ws.setLocation(focusedPane.value, s, '/' + segs.join('/'));
}, { immediate: true });
const selectQuery = computed(() => (typeof route.query.select === 'string' ? route.query.select : null));
// Another pane or tab in front puts its place in the address bar, without a history entry of its own.
watch(() => focusedTab.value.id, () => {
  const to = folderRoute(focusedTab.value.source, focusedTab.value.path);
  if (route.path !== to) void router.replace(to);
});
function setFocus(p: P) { if (dual.value && ws.focused !== p) ws.focused = p; }

// The folder each pane would copy or move into: the other pane's active tab, once its listing is in.
function otherOf(p: P): OtherPane | null {
  if (!dual.value) return null;
  const tab = ws.activeTab(p === 0 ? 1 : 0);
  const f = useFolderStore(tab.id);
  const ready = !f.loading && !f.error && f.source === tab.source && f.path === tab.path;
  return { source: f.source, path: f.path, editable: ready && f.access === 'edit', names: f.entries.map((e) => e.name) };
}
const others = computed(() => [otherOf(0), otherOf(1)] as const);

const panes = new Map<string, InstanceType<typeof FolderPane>>();
function setPane(id: string, el: unknown) {
  if (el) panes.set(id, el as InstanceType<typeof FolderPane>); else panes.delete(id);
}
const paneOf = (p: P) => panes.get(ws.activeTab(p).id);

// Each tab's scroll: the pane's own body with two panes, else the page.
const bodies: (HTMLElement | null)[] = [null, null];
const scrolls = new Map<string, number>();
const scroller = (p: P) => (dual.value ? bodies[p] : document.scrollingElement);
function keepScroll(p: P) {
  const el = scroller(p);
  if (el) scrolls.set(ws.activeTab(p).id, el.scrollTop);
}
async function showScroll(p: P) {
  await nextTick();
  const el = scroller(p);
  if (el) el.scrollTop = scrolls.get(ws.activeTab(p).id) ?? 0;
}
function selectTab(p: P, i: number) {
  setFocus(p);
  const pane = ws.panes[p];
  if (i === pane.active) return;
  keepScroll(p);
  pane.active = i;
  void showScroll(p);
}
function newTab(p: P) {
  setFocus(p);
  keepScroll(p);
  ws.addTab(p);
  void showScroll(p);
}
async function closeTab(p: P, id: string) {
  setFocus(p);
  const closingActive = ws.activeTab(p).id === id;
  ws.closeTab(p, id);
  scrolls.delete(id);
  if (closingActive) void showScroll(p);
  await nextTick(); // the closed tab's button is gone with the focus: it goes to the tab now in front
  document.getElementById(`tab-${ws.activeTab(p).id}`)?.focus();
}
// The tab strip is one Tab stop; the arrows, Home and End move between the tabs and show them.
function onTabKey(e: KeyboardEvent, p: P, i: number) {
  const n = ws.panes[p].tabs.length;
  const to = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  selectTab(p, to);
  document.getElementById(`tab-${ws.panes[p].tabs[to]!.id}`)?.focus();
}
const tabLabel = (tab: Tab) => (tab.path === '/' ? sourceName(tab.source) : tab.path.slice(tab.path.lastIndexOf('/') + 1));

// Tab from the list or gallery of one pane goes to the other pane's, as in two-pane file managers; Shift+Tab and Tab
// everywhere else move the focus as usual.
function onKeydown(e: KeyboardEvent) {
  if (!dual.value || e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
  const at = e.target instanceof Element ? e.target : null;
  if (!at?.closest('.folder-content')) return;
  const p = Number(at.closest<HTMLElement>('[data-pane]')?.dataset.pane) as P;
  const other: P = p === 0 ? 1 : 0;
  e.preventDefault();
  ws.focused = other;
  paneOf(other)?.focusItems();
}
// F5 copies and F6 moves the focused pane's selection to the other pane; Ctrl+T and Ctrl+W open and close a tab where
// the browser lets them through (an installed app). Never while typing or while a dialog is open.
function onWindowKey(e: KeyboardEvent) {
  if (e.altKey || e.metaKey) return;
  const at = e.target instanceof HTMLElement ? e.target : null;
  if (at?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  if (document.querySelector('[aria-modal="true"]')) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (dual.value && !e.ctrlKey && !e.shiftKey && (key === 'F5' || key === 'F6')) {
    e.preventDefault(); // F5 would reload the page and lose the panes
    void paneOf(focusedPane.value)?.toOther(key === 'F6' ? 'move' : 'copy');
  } else if (layout.tabs && e.ctrlKey && !e.shiftKey && key === 't') {
    e.preventDefault();
    newTab(focusedPane.value);
  } else if (layout.tabs && e.ctrlKey && !e.shiftKey && key === 'w' && ws.panes[focusedPane.value].tabs.length > 1) {
    e.preventDefault(); // the last tab is not closed: the browser may close its own then
    void closeTab(focusedPane.value, focusedTab.value.id);
  }
}
onMounted(() => window.addEventListener('keydown', onWindowKey));
onUnmounted(() => window.removeEventListener('keydown', onWindowKey));

// With two panes each scrolls on its own, down to the bottom of the window.
const root = ref<HTMLElement>();
const paneTop = ref(0);
function measure() { if (root.value) paneTop.value = root.value.getBoundingClientRect().top + scrollY; }
watch([dual, root], () => { void nextTick(measure); });
onMounted(() => window.addEventListener('resize', measure));
onUnmounted(() => window.removeEventListener('resize', measure));
</script>

<template>
  <!-- Both layouts off: the one pane alone, the page column as before. -->
  <FolderPane
    v-if="plain"
    :key="ws.activeTab(0).id"
    :ref="(el) => setPane(ws.activeTab(0).id, el)"
    :tab-id="ws.activeTab(0).id"
    :source="ws.activeTab(0).source"
    :path="ws.activeTab(0).path"
    :view="ws.deviceView"
    :focused="true"
    :select="selectQuery"
    :other="null"
    :tabs="false"
    @update:view="ws.setView(ws.activeTab(0).id, $event)"
  />
  <div
    v-else
    ref="root"
    class="workspace"
    :class="{ dual, tabbed: layout.tabs }"
    :style="{ '--pane-top': `${paneTop}px` }"
    @keydown="onKeydown"
  >
    <!-- A named section is a region: with two panes each is one ("Left pane", "Right pane"). -->
    <section
      v-for="p in shown"
      :key="p"
      class="pane"
      :class="{ focused: dual && focusedPane === p }"
      :data-pane="p"
      :aria-label="dual ? t(p === 0 ? 'dualPane.left' : 'dualPane.right') : undefined"
      :aria-current="dual && focusedPane === p ? 'true' : undefined"
      @focusin="setFocus(p)"
      @pointerdown.capture="setFocus(p)"
    >
      <div
        v-if="layout.tabs"
        class="tab-strip"
      >
        <div
          class="tab-list"
          role="tablist"
          :aria-label="t('tabs.label')"
        >
          <div
            v-for="(tab, i) in ws.panes[p].tabs"
            :key="tab.id"
            class="tab-item"
            :class="{ active: i === ws.panes[p].active }"
          >
            <button
              :id="`tab-${tab.id}`"
              type="button"
              role="tab"
              class="tab"
              :aria-selected="i === ws.panes[p].active"
              :aria-controls="`panel-${tab.id}`"
              :tabindex="i === ws.panes[p].active ? 0 : -1"
              :title="tabLabel(tab)"
              @click="selectTab(p, i)"
              @keydown="onTabKey($event, p, i)"
            >
              <span
                class="icon icon-folder"
                aria-hidden="true"
              />
              <span class="tab-name">{{ tabLabel(tab) }}</span>
            </button>
            <button
              v-if="ws.panes[p].tabs.length > 1"
              type="button"
              class="icon-button tab-close"
              :aria-label="t('tabs.close', { name: tabLabel(tab) })"
              :title="t('tabs.close', { name: tabLabel(tab) })"
              @click="closeTab(p, tab.id)"
            >
              <span
                class="icon icon-close"
                aria-hidden="true"
              />
            </button>
          </div>
        </div>
        <button
          type="button"
          class="icon-button tab-new"
          :aria-label="t('tabs.new')"
          :title="t('tabs.new')"
          @click="newTab(p)"
        >
          <span
            class="icon icon-plus"
            aria-hidden="true"
          />
        </button>
      </div>
      <div
        :ref="(el) => { bodies[p] = el as HTMLElement | null }"
        class="pane-body"
      >
        <template
          v-for="(tab, i) in ws.panes[p].tabs"
          :key="tab.id"
        >
          <div
            v-if="layout.tabs || i === ws.panes[p].active"
            v-show="i === ws.panes[p].active"
            :id="layout.tabs ? `panel-${tab.id}` : undefined"
            class="tab-panel"
          >
            <FolderPane
              :ref="(el) => setPane(tab.id, el)"
              :tab-id="tab.id"
              :source="tab.source"
              :path="tab.path"
              :view="tab.view"
              :focused="p === focusedPane && i === ws.panes[p].active"
              :select="p === focusedPane && i === ws.panes[p].active ? selectQuery : null"
              :other="others[p]"
              :tabs="layout.tabs"
              @update:view="ws.setView(tab.id, $event)"
              @open-tab="(source: string, path: string) => ws.openInTab(p, source, path)"
            />
          </div>
        </template>
      </div>
    </section>
  </div>
</template>
