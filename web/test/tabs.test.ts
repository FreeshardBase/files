import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { restoreWorkspace, TABS_KEY, useWorkspaceStore } from '../src/stores/workspace.ts';

// #219: the open tabs are kept per device in local storage. Whatever cannot be read back (storage blocked, broken
// JSON, a foreign shape, an unknown source) starts over with one tab per pane at the home's root.

const home = { source: 'home', path: '/', view: 'list' };
const locations = (w: ReturnType<typeof restoreWorkspace>) => w.panes.map((p) => ({ active: p.active,
  tabs: p.tabs.map(({ source, path, view }) => ({ source, path, view })) }));

beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()); vi.restoreAllMocks(); });

describe('restoring tabs', () => {
  it('restores every pane\'s tabs, the active ones and the focused pane, with fresh ids', () => {
    const stored = { focused: 1, panes: [
      { active: 2, tabs: [home, { source: 'conn:abc', path: '/Reports', view: 'gallery' }, { source: 'share:x1', path: '/', view: 'list' }] },
      { active: 0, tabs: [{ source: 'home', path: '/Photos', view: 'list' }] },
    ] };
    const w = restoreWorkspace(() => JSON.stringify(stored), 'list');
    expect(w.focused).toBe(1);
    expect(locations(w)).toEqual(stored.panes);
    const ids = w.panes.flatMap((p) => p.tabs.map((t) => t.id));
    expect(new Set(ids).size).toBe(4);
  });

  it.each([
    ['nothing stored', () => null],
    ['broken JSON', () => '{"panes": ['],
    ['storage blocked', () => { throw new DOMException('denied', 'SecurityError'); }],
    ['one pane only', () => JSON.stringify({ focused: 0, panes: [{ active: 0, tabs: [home] }] })],
    ['a pane without tabs', () => JSON.stringify({ focused: 0, panes: [{ active: 0, tabs: [] }, { active: 0, tabs: [home] }] })],
    ['an unknown source', () => JSON.stringify({ focused: 0, panes: [{ active: 0, tabs: [{ ...home, source: '../etc' }] }, { active: 0, tabs: [home] }] })],
    ['a relative path', () => JSON.stringify({ focused: 0, panes: [{ active: 0, tabs: [{ ...home, path: 'x' }] }, { active: 0, tabs: [home] }] })],
    ['a bad focus', () => JSON.stringify({ focused: 2, panes: [{ active: 0, tabs: [home] }, { active: 0, tabs: [home] }] })],
  ])('falls back to one tab per pane: %s', (_, read) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = restoreWorkspace(read as () => string | null, 'gallery');
    expect(w.focused).toBe(0);
    expect(locations(w)).toEqual([{ active: 0, tabs: [{ ...home, view: 'gallery' }] }, { active: 0, tabs: [{ ...home, view: 'gallery' }] }]);
  });
});

describe('the open tabs', () => {
  it('a new tab opens beside the active one at the same place, and the tabs come back after a reload', async () => {
    const ws = useWorkspaceStore();
    ws.setLocation(0, 'conn:abc', '/Reports');
    ws.addTab(0);
    ws.setLocation(0, 'home', '/Photos');
    ws.openInTab(0, 'home', '/Photos/2026'); // a middle click: behind the active tab
    expect(ws.panes[0].active).toBe(1);
    expect(ws.panes[0].tabs.map((t) => t.path)).toEqual(['/Reports', '/Photos', '/Photos/2026']);
    await nextTick(); // the store writes after the change
    setActivePinia(createPinia());
    const again = useWorkspaceStore();
    expect(again.panes[0].tabs.map((t) => [t.source, t.path])).toEqual([['conn:abc', '/Reports'], ['home', '/Photos'], ['home', '/Photos/2026']]);
    expect(again.panes[0].active).toBe(1);
    expect(JSON.parse(localStorage.getItem(TABS_KEY)!).panes[0].tabs).toHaveLength(3);
  });

  it('closing keeps the right tab in front, and the last tab of a pane cannot be closed', () => {
    const ws = useWorkspaceStore();
    ws.addTab(0); ws.addTab(0);
    const [a, b, c] = ws.panes[0].tabs.map((t) => t.id);
    ws.panes[0].active = 1;
    ws.closeTab(0, b!);
    expect(ws.panes[0].tabs.map((t) => t.id)).toEqual([a, c]);
    expect(ws.activeTab(0).id).toBe(c);
    ws.closeTab(0, c!);
    expect(ws.activeTab(0).id).toBe(a);
    ws.closeTab(0, a!);
    expect(ws.panes[0].tabs.map((t) => t.id)).toEqual([a]);
  });

  it('each tab keeps its own view', () => {
    const ws = useWorkspaceStore();
    ws.addTab(0);
    const [a, b] = ws.panes[0].tabs;
    ws.setView(b!.id, 'gallery');
    expect([a!.view, b!.view]).toEqual(['list', 'gallery']);
  });
});
