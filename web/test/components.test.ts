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

describe('FileList accessibility and focus', () => {
  const many = Array.from({ length: 4 }, (_, i) => ({ name: `f${i}`, path: `/f${i}`, type: 'directory' as const, size: 0, modified: '2026-10-14T00:00:00.000Z' }));
  it('declares table semantics explicitly', () => {
    const w = mount(FileList, { props: { entries, folderName: 'x' }, global: { plugins: [i18n] } });
    expect(w.find('table').attributes('role')).toBe('table');
    expect(w.findAll('[role=row]')).toHaveLength(3);
    expect(w.findAll('[role=columnheader]')).toHaveLength(3);
    expect(w.findAll('[role=cell]')).toHaveLength(6);
  });
  it('a click moves the tab stop to that row', async () => {
    const w = mount(FileList, { props: { entries, folderName: 'x' }, global: { plugins: [i18n] } });
    await w.findAll('tbody tr')[1]!.trigger('click');
    expect(w.findAll('tbody tr').map((r) => r.attributes('tabindex'))).toEqual(['-1', '0']);
  });
  it('Space opens a directory', async () => {
    const w = mount(FileList, { props: { entries, folderName: 'x' }, global: { plugins: [i18n] } });
    await w.findAll('tbody tr')[0]!.trigger('keydown', { key: ' ' });
    expect(w.emitted('open')![0]).toEqual([entries[0]]);
  });
  it('keeps the tab stop in range when the list shrinks', async () => {
    const w = mount(FileList, { props: { entries: many, folderName: 'x' }, global: { plugins: [i18n] } });
    await w.findAll('tbody tr')[3]!.trigger('click');
    await w.setProps({ entries: many.slice(0, 2) });
    expect(w.findAll('tbody tr').map((r) => r.attributes('tabindex'))).toEqual(['-1', '0']);
  });
});
