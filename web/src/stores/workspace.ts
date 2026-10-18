import { defineStore } from 'pinia';
import { nextTick, ref, watch } from 'vue';
import type { NameRuleSet } from '@files/shared';
import { disposeFolderStore } from './folder.ts';

// The open locations (#218 two panes, #219 tabs). There are always two panes, each with at least one tab; which of them
// show depends on the member's settings and the screen: without two panes only the first pane shows, without tabs only
// each pane's active tab. The address bar always shows the location of the focused pane's active tab.
// The panes and tabs are kept per device in local storage; selection and scroll live with the open view only.

export type View = 'list' | 'gallery';
export type Tab = { id: string; source: string; path: string; view: View };
export type Pane = { tabs: Tab[]; active: number };
export type Workspace = { panes: [Pane, Pane]; focused: 0 | 1 };
/** The folder the other pane shows, as a pane sees it: where "to the other pane" goes and which names are taken there. */
export type OtherPane = { source: string; path: string; editable: boolean; names: string[]; nameRules: NameRuleSet };

/** List or gallery (#144) on this device: the view a new tab starts with, and the only one without tabs. */
export const VIEW_KEY = 'files.view';
export const TABS_KEY = 'files.tabs';

// The sources the router knows (router.ts); a stored tab of anything else is not restored.
const SOURCE = /^(home|share:[A-Za-z0-9_-]{1,64}|conn:[A-Za-z0-9_-]{1,64})$/;
let seq = 0;
export const newTab = (source: string, path: string, view: View): Tab => ({ id: `t${++seq}`, source, path, view });
const onePane = (view: View): Pane => ({ tabs: [newTab('home', '/', view)], active: 0 });

function parseTab(x: unknown): Tab {
  const t = x as Partial<Tab> | null;
  if (typeof t?.source !== 'string' || !SOURCE.test(t.source) || typeof t.path !== 'string' || !t.path.startsWith('/')
    || (t.view !== 'list' && t.view !== 'gallery')) throw new Error('stored tab is malformed');
  return newTab(t.source, t.path, t.view);
}
function parsePane(x: unknown): Pane {
  const p = x as { tabs?: unknown; active?: unknown } | null;
  if (!Array.isArray(p?.tabs) || p.tabs.length === 0 || !Number.isInteger(p.active)) throw new Error('stored pane is malformed');
  const tabs = p.tabs.map(parseTab);
  return { tabs, active: Math.min(Math.max(p.active as number, 0), tabs.length - 1) };
}

/**
 * The workspace stored on this device, or one tab in each pane (at the home's root) when there is none or it cannot be
 * read: storage blocked, broken JSON, an old or foreign shape.
 */
export function restoreWorkspace(read: () => string | null, view: View): Workspace {
  try {
    const raw = read();
    if (raw === null) return { panes: [onePane(view), onePane(view)], focused: 0 };
    const w = JSON.parse(raw) as { panes?: unknown; focused?: unknown } | null;
    if (!Array.isArray(w?.panes) || w.panes.length !== 2 || (w.focused !== 0 && w.focused !== 1)) throw new Error('stored workspace is malformed');
    return { panes: [parsePane(w.panes[0]), parsePane(w.panes[1])], focused: w.focused };
  } catch (e) { // handled: what cannot be restored starts over with one tab per pane, as on a new device
    console.warn('open tabs not restored', e);
    return { panes: [onePane(view), onePane(view)], focused: 0 };
  }
}

/** What is stored: the tabs without their ids, which are made anew on every load. */
export const storedForm = (w: Workspace): string => JSON.stringify({
  focused: w.focused,
  panes: w.panes.map((p) => ({ active: p.active, tabs: p.tabs.map(({ source, path, view }) => ({ source, path, view })) })),
});

export const useWorkspaceStore = defineStore('workspace', () => {
  // The device's view: the one view without tabs (as before #219), and the view a new tab starts with.
  const deviceView = ref<View>(localStorage.getItem(VIEW_KEY) === 'gallery' ? 'gallery' : 'list');
  const start = restoreWorkspace(() => localStorage.getItem(TABS_KEY), deviceView.value);
  const panes = ref<[Pane, Pane]>(start.panes);
  const focused = ref<0 | 1>(start.focused);
  watch([panes, focused], () => { localStorage.setItem(TABS_KEY, storedForm({ panes: panes.value, focused: focused.value })); },
    { deep: true });
  // The last change one pane made to a folder another pane may show; every pane relists when it shows one of `dirs`.
  const changed = ref<{ by: string; source: string; dirs: string[] } | null>(null);

  const activeTab = (p: 0 | 1): Tab => panes.value[p].tabs[panes.value[p].active]!;
  function setLocation(p: 0 | 1, source: string, path: string) {
    const t = activeTab(p);
    if (t.source !== source || t.path !== path) { t.source = source; t.path = path; }
  }
  function setView(id: string, view: View) {
    for (const pane of panes.value) for (const t of pane.tabs) if (t.id === id) t.view = view;
    deviceView.value = view;
    localStorage.setItem(VIEW_KEY, view);
  }
  /** A new tab after the active one, at the same place. */
  function addTab(p: 0 | 1) {
    const pane = panes.value[p]; const t = activeTab(p);
    pane.tabs.splice(pane.active + 1, 0, newTab(t.source, t.path, t.view));
    pane.active++;
  }
  /** A folder in a new tab behind the active one (a middle click), as a browser does with a link. */
  function openInTab(p: 0 | 1, source: string, path: string) {
    const pane = panes.value[p];
    pane.tabs.splice(pane.active + 1, 0, newTab(source, path, activeTab(p).view));
  }
  /** Closes a tab; the last tab of a pane cannot be closed. */
  function closeTab(p: 0 | 1, id: string) {
    const pane = panes.value[p];
    const i = pane.tabs.findIndex((t) => t.id === id);
    if (i < 0 || pane.tabs.length === 1) return;
    pane.tabs.splice(i, 1);
    if (pane.active > i || pane.active === pane.tabs.length) pane.active--;
    void nextTick(() => { disposeFolderStore(id); }); // once the tab's pane is gone
  }
  function touch(by: string, source: string, dirs: string[]) { changed.value = { by, source, dirs }; }
  return { panes, focused, changed, deviceView, activeTab, setLocation, setView, addTab, openInTab, closeTab, touch };
});
