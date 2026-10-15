import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { createMemoryHistory, createRouter } from 'vue-router';
import en from '../src/i18n/en.json';
import FileList from '../src/components/FileList.vue';
import Breadcrumbs from '../src/components/Breadcrumbs.vue';
import UploadButton from '../src/components/UploadButton.vue';

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:source(home)/:path(.*)*', component: { template: '<div />' } }] });
const entries = [
  { name: 'Fotos', path: '/Fotos', type: 'directory' as const, size: 0, modified: '2026-10-14T00:00:00.000Z' },
  { name: 'a b.txt', path: '/a b.txt', type: 'file' as const, size: 1500, modified: '2026-10-14T00:00:00.000Z' },
];

describe('FileList', () => {
  it('links files to the download endpoint with an encoded path', () => {
    const w = mount(FileList, { props: { entries, folderName: 'x' }, global: { plugins: [i18n] } });
    expect(w.find('a').attributes('href')).toBe('/api/v1/sources/home/content?path=%2Fa%20b.txt&download=1');
  });
  it('links downloads to the given source', () => {
    const w = mount(FileList, { props: { entries, folderName: 'x', source: 'conn:1' }, global: { plugins: [i18n] } });
    expect(w.find('a').attributes('href')).toBe('/api/v1/sources/conn%3A1/content?path=%2Fa%20b.txt&download=1');
  });
  it('has exactly one tab stop and moves it with the arrow keys; Enter opens', async () => {
    const w = mount(FileList, { props: { entries, folderName: 'x' }, attachTo: document.body, global: { plugins: [i18n] } });
    const rows = w.findAll('tbody tr');
    expect(rows.map((r) => r.attributes('tabindex'))).toEqual(['0', '-1']);
    await rows[0]!.trigger('keydown', { key: 'ArrowDown' });
    expect(rows.map((r) => r.attributes('tabindex'))).toEqual(['-1', '0']);
    await rows[0]!.trigger('keydown', { key: 'Enter' });
    expect(w.emitted('open')![0]).toEqual([entries[0]]);
    w.unmount();
  });
  it('Enter on a file row triggers its download link instead of opening', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const w = mount(FileList, { props: { entries, folderName: 'x' }, global: { plugins: [i18n] } });
    await w.findAll('tbody tr')[1]!.trigger('keydown', { key: 'Enter' });
    expect(click).toHaveBeenCalledTimes(1);
    expect(w.emitted('open')).toBeUndefined();
    click.mockRestore();
  });
});

describe('Breadcrumbs', () => {
  it('encodes each segment in the link target', () => {
    const w = mount(Breadcrumbs, { props: { source: 'home', path: '/a b/c' }, global: { plugins: [i18n, router] } });
    expect(w.findAll('a').map((a) => a.attributes('href'))).toEqual(['/home', '/home/a%20b', '/home/a%20b/c']);
  });
});

describe('UploadButton', () => {
  it('keeps the file input focusable (not display:none, not removed from tab order)', () => {
    const w = mount(UploadButton, { global: { plugins: [i18n] } });
    const input = w.find('input[type=file]');
    expect(input.attributes('tabindex')).toBeUndefined();
    expect(input.attributes('hidden')).toBeUndefined();
    expect(input.classes()).toContain('visually-hidden');
  });
});

describe('FileList actions', () => {
  const both = { entries, folderName: 'x', selected: ['/Fotos', '/a b.txt'] };
  const key = async (w: ReturnType<typeof mount>, row: number, k: string, mods: Record<string, boolean> = {}) =>
    w.findAll('tbody tr')[row]!.trigger('keydown', { key: k, ...mods });
  it('F2 renames the focused row only, even inside a selection', async () => {
    const w = mount(FileList, { props: both, global: { plugins: [i18n] } });
    await key(w, 1, 'F2');
    expect(w.emitted('action')).toEqual([['rename', [entries[1]]]]);
  });
  it('Delete, Ctrl+C and Ctrl+X act on the whole selection when the row is part of it, else on the row', async () => {
    const w = mount(FileList, { props: both, global: { plugins: [i18n] } });
    await key(w, 0, 'Delete'); await key(w, 0, 'c', { ctrlKey: true }); await key(w, 1, 'X', { metaKey: true, shiftKey: true });
    expect(w.emitted('action')).toEqual([['trash', entries], ['copy', entries], ['cut', entries]]);
    await w.setProps({ selected: ['/Fotos'] });
    await key(w, 1, 'Delete');
    expect(w.emitted('action')![3]).toEqual(['trash', [entries[1]]]);
  });
  it('Ctrl+V pastes and Ctrl+A selects everything', async () => {
    const w = mount(FileList, { props: { entries, folderName: 'x' }, global: { plugins: [i18n] } });
    await key(w, 0, 'v', { ctrlKey: true }); await key(w, 0, 'a', { ctrlKey: true });
    expect(w.emitted('paste')).toHaveLength(1);
    expect(w.emitted('update:selected')).toEqual([[['/Fotos', '/a b.txt']]]);
  });
  it('Ctrl+click toggles and Shift+click selects a range', async () => {
    const w = mount(FileList, { props: { entries, folderName: 'x' }, global: { plugins: [i18n] } });
    await w.findAll('tbody tr')[0]!.trigger('click', { ctrlKey: true });
    await w.findAll('tbody tr')[1]!.trigger('click', { shiftKey: true });
    expect(w.emitted('update:selected')).toEqual([[['/Fotos']], [['/Fotos', '/a b.txt']]]);
  });
  it('Shift+F10 opens the row menu; choosing an item closes it, focuses the row and emits the action', async () => {
    const w = mount(FileList, { props: { entries, folderName: 'x' }, attachTo: document.body, global: { plugins: [i18n] } });
    await key(w, 1, 'F10', { shiftKey: true });
    await new Promise((r) => setTimeout(r));
    const menu = w.find('[role=menu]');
    expect(menu.attributes('aria-label')).toBe('Actions for a b.txt');
    const items = menu.findAll('[role=menuitem]');
    expect(items.map((i) => i.text())).toEqual(['Download', 'Rename', 'Move', 'Copy', 'Move to trash']);
    expect(document.activeElement).toBe(items[0]!.element);
    await menu.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]!.element);
    await items[4]!.trigger('click');
    expect(w.find('[role=menu]').exists()).toBe(false);
    expect(document.activeElement).toBe(w.findAll('tbody tr')[1]!.element);
    expect(w.emitted('action')).toEqual([['trash', [entries[1]]]]);
    w.unmount();
  });
  it('keys inside the open menu do not reach the row', async () => {
    const w = mount(FileList, { props: { entries, folderName: 'x' }, attachTo: document.body, global: { plugins: [i18n] } });
    await w.findAll('.icon-button')[0]!.trigger('click');
    await w.find('[role=menu]').trigger('keydown', { key: 'Delete' });
    expect(w.emitted('action')).toBeUndefined();
    await w.find('[role=menu]').trigger('keydown', { key: 'Escape' });
    expect(w.find('[role=menu]').exists()).toBe(false);
    w.unmount();
  });
  it('dropping list items on a folder row moves them there; a file row is no target', async () => {
    const w = mount(FileList, { props: { entries, folderName: 'x' }, global: { plugins: [i18n] } });
    const data = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '',
      get types() { return [...data.keys()]; }, effectAllowed: '', dropEffect: '' };
    await w.findAll('tbody tr')[1]!.trigger('dragstart', { dataTransfer });
    await w.findAll('tbody tr')[1]!.trigger('drop', { dataTransfer });
    await w.findAll('tbody tr')[0]!.trigger('drop', { dataTransfer });
    expect(w.emitted('drop')).toEqual([[['/a b.txt'], '/Fotos']]);
  });
});

describe('FileList accessibility and focus', () => {
  const many = Array.from({ length: 4 }, (_, i) => ({ name: `f${i}`, path: `/f${i}`, type: 'directory' as const, size: 0, modified: '2026-10-14T00:00:00.000Z' }));
  it('declares table semantics explicitly', () => {
    const w = mount(FileList, { props: { entries, folderName: 'x' }, global: { plugins: [i18n] } });
    expect(w.find('table').attributes('role')).toBe('table');
    expect(w.findAll('[role=row]')).toHaveLength(3);
    expect(w.findAll('[role=columnheader]')).toHaveLength(5);
    expect(w.findAll('[role=cell]')).toHaveLength(10);
  });
  it('a click moves the tab stop to that row', async () => {
    const w = mount(FileList, { props: { entries, folderName: 'x' }, global: { plugins: [i18n] } });
    await w.findAll('tbody tr')[1]!.trigger('click');
    expect(w.findAll('tbody tr').map((r) => r.attributes('tabindex'))).toEqual(['-1', '0']);
  });
  it('Space toggles the selection of the row (Enter opens)', async () => {
    const w = mount(FileList, { props: { entries, folderName: 'x' }, global: { plugins: [i18n] } });
    await w.findAll('tbody tr')[0]!.trigger('keydown', { key: ' ' });
    expect(w.emitted('update:selected')![0]).toEqual([['/Fotos']]);
    expect(w.emitted('open')).toBeUndefined();
    await w.setProps({ selected: ['/Fotos'] });
    expect(w.findAll('tbody tr')[0]!.attributes('aria-selected')).toBe('true');
    await w.findAll('tbody tr')[0]!.trigger('keydown', { key: ' ' });
    expect(w.emitted('update:selected')![1]).toEqual([[]]);
  });
  it('keeps the tab stop in range when the list shrinks', async () => {
    const w = mount(FileList, { props: { entries: many, folderName: 'x' }, global: { plugins: [i18n] } });
    await w.findAll('tbody tr')[3]!.trigger('click');
    await w.setProps({ entries: many.slice(0, 2) });
    expect(w.findAll('tbody tr').map((r) => r.attributes('tabindex'))).toEqual(['-1', '0']);
  });
});
