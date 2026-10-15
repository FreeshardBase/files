import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent, h } from 'vue';
import en from '../src/i18n/en.json';
import { routes } from '../src/router.ts';
import FolderView from '../src/views/FolderView.vue';
import UploadPanel from '../src/components/UploadPanel.vue';
import { walkEntries } from '../src/dnd.ts';
import { installFakeTus, type FakeTusOptions } from './fakeTus.ts';

// #140: uploads go through the tus client and the uploads store; the panel shows progress and one failure summary.
const i18n = () => createI18n({ legacy: false, locale: 'en', messages: { en } });
const Shell = defineComponent({ render: () => [h(UploadPanel), h(FolderView)] });
let w: VueWrapper | undefined;

beforeEach(() => { setActivePinia(createPinia()); localStorage.clear(); });
afterEach(() => { w?.unmount(); w = undefined; vi.restoreAllMocks(); });

async function mountAt(path: string, opts: FakeTusOptions = {}) {
  const tus = installFakeTus(opts);
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  w = mount(Shell, { attachTo: document.body, global: { plugins: [i18n(), router] } });
  await flushPromises();
  return { tus, router, w };
}
const pick = async (files: File[], testid = 'upload-input') => {
  const input = w!.find(`[data-testid=${testid}]`);
  Object.defineProperty(input.element, 'files', { value: files, configurable: true });
  await input.trigger('change');
};
const settled = async () => {
  await vi.waitFor(() => { if (w!.findAll('.upload-item').some((i) => ['queued', 'uploading'].includes(i.attributes('data-state')!))) throw new Error('busy'); }, { timeout: 5000 });
  await flushPromises();
};
const status = () => w!.find('[role=status]').text();
const dialogs = () => document.querySelectorAll('[role="dialog"]');
const button = (label: string) => [...dialogs()[0]!.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;

describe('upload panel', () => {
  it('summarises a mixed batch once, lists every failure in one summary with "retry all", never alert()', async () => {
    const alert = vi.fn(); vi.stubGlobal('alert', alert);
    let full = true;
    const { tus } = await mountAt('/home', { onCreate: (p) => (p === '/b.txt' && full ? { status: 507, text: '{"code":"QUOTA_EXCEEDED"}' } : undefined) });
    await pick(['a.txt', 'b.txt', 'c.txt'].map((n) => new File(['x'], n)));
    await settled();
    expect(status()).toBe('2 of 3 uploaded');
    expect(w!.findAll('[data-testid=upload-summary]')).toHaveLength(1);
    const summary = w!.find('[data-testid=upload-summary]');
    expect(summary.text()).toContain('One upload failed.');
    expect(summary.text()).toContain(`b.txt: ${en.errors.QUOTA_EXCEEDED}`);
    expect(tus.log.lists).toBe(2); // the first listing and one relist for the batch
    full = false;
    await summary.findAll('button').find((b) => b.text() === en.upload.retryAll)!.trigger('click');
    await settled();
    expect(w!.find('[data-testid=upload-summary]').exists()).toBe(false);
    expect(status()).toBe('3 of 3 uploaded');
    expect(tus.log.placed).toEqual(['/a.txt:fail', '/c.txt:fail', '/b.txt:fail']);
    expect(alert).not.toHaveBeenCalled();
  });

  it('shows progress per file and a finished file at 100 %', async () => {
    await mountAt('/home');
    await pick([new File(['hello'], 'a.txt')]);
    await settled();
    const bar = w!.find('[role=progressbar]');
    expect(bar.attributes('aria-valuenow')).toBe('100');
    expect(bar.attributes('aria-label')).toBe('Upload progress of a.txt');
    expect(w!.find('.upload-state').text()).toBe(en.upload.state.done);
  });

  it('pauses and resumes an upload; it continues from the offset the server has', async () => {
    let stall = true;
    const { tus } = await mountAt('/home', { onPatch: () => (stall ? { keep: 2, answer: new Promise(() => undefined) } : undefined) });
    await pick([new File(['0123456789'], 'a.txt')]);
    await vi.waitFor(() => expect(tus.log.patches).toHaveLength(1));
    await w!.find('button[aria-label="Pause upload of a.txt"]').trigger('click');
    await vi.waitFor(() => expect(w!.find('.upload-item').attributes('data-state')).toBe('paused'));
    expect(status()).toBe(''); // a paused item keeps its batch open
    stall = false;
    await w!.find('button[aria-label="Resume upload of a.txt"]').trigger('click');
    await settled();
    expect(tus.log.patches).toEqual(['/a.txt@0', '/a.txt@2']);
    expect(status()).toBe('1 of 1 uploaded');
  });

  it('cancel drops the upload on the server', async () => {
    const { tus } = await mountAt('/home', { onPatch: () => ({ keep: 2, answer: new Promise(() => undefined) }) });
    await pick([new File(['0123456789'], 'a.txt')]);
    await vi.waitFor(() => expect(tus.log.patches).toHaveLength(1));
    await w!.find('button[aria-label="Cancel upload of a.txt"]').trigger('click');
    await flushPromises();
    expect(w!.find('.upload-item').attributes('data-state')).toBe('cancelled');
    expect(tus.log.deleted).toEqual(['u1']);
    expect(status()).toBe('0 of 1 uploaded');
  });
});

describe('collisions', () => {
  it('asks on FILE_EXISTS, sends again with the chosen policy, and "apply to all" asks once', async () => {
    const { tus } = await mountAt('/home', { taken: () => true });
    void pick(['a.txt', 'b.txt', 'c.txt'].map((n) => new File(['x'], n)));
    await vi.waitFor(() => expect(dialogs()).toHaveLength(1));
    expect(dialogs()[0]!.textContent).toContain('a.txt');
    button(en.collision.keepBoth).click(); // this item only
    await vi.waitFor(() => expect(dialogs()[0]?.textContent).toContain('b.txt'));
    dialogs()[0]!.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
    await flushPromises();
    button(en.collision.replace).click();
    await settled();
    expect(dialogs()).toHaveLength(0);
    expect(tus.log.created).toEqual(['/a.txt:fail', '/a.txt:keep-both', '/b.txt:fail', '/b.txt:replace', '/c.txt:replace']);
    expect(status()).toBe('3 of 3 uploaded');
  });

  it('a name taken at the end asks, then places the bytes already sent without sending them again', async () => {
    let taken = false;
    const { tus } = await mountAt('/home', { taken: () => taken, onPatch: () => { taken = true; return undefined; } });
    void pick([new File(['0123456789'], 'a.txt')]);
    await vi.waitFor(() => expect(dialogs()).toHaveLength(1));
    button(en.collision.replace).click();
    await settled();
    expect(tus.log.patches).toEqual(['/a.txt@0']);
    expect(tus.log.placed).toEqual(['/a.txt:replace']);
    expect(status()).toBe('1 of 1 uploaded');
  });

  it('skip counts as skipped, not failed, and drops what the server holds', async () => {
    let taken = false;
    const { tus } = await mountAt('/home', { taken: () => taken, onPatch: () => { taken = true; return undefined; } });
    void pick([new File(['x'], 'a.txt')]);
    await vi.waitFor(() => expect(dialogs()).toHaveLength(1));
    button(en.collision.skip).click();
    await settled();
    expect(status()).toBe('0 of 1 uploaded, 1 skipped');
    expect(w!.find('[data-testid=upload-summary]').exists()).toBe(false);
    expect(tus.log.deleted).toEqual(['u1']);
  });
});

describe('targets', () => {
  it('keeps uploading to the original folder when the route changes mid-batch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { tus, router } = await mountAt('/home/A', { onCreate: async () => { await gate; return undefined; } });
    void pick(['1.txt', '2.txt'].map((n) => new File(['x'], n)));
    await router.push('/home/B');
    await flushPromises();
    release();
    await settled();
    expect(tus.log.placed).toEqual(['/A/1.txt:fail', '/A/2.txt:fail']);
  });

  it('a picked folder keeps its structure below the open folder', async () => {
    const { tus } = await mountAt('/home/A');
    const files = ['Album/x.txt', 'Album/2026/y.txt'].map((rel) => {
      const f = new File(['x'], rel.split('/').pop()!);
      Object.defineProperty(f, 'webkitRelativePath', { value: rel });
      return f;
    });
    await pick(files, 'upload-folder-input');
    await settled();
    expect(tus.log.placed).toEqual(['/A/Album/x.txt:fail', '/A/Album/2026/y.txt:fail']);
    expect(w!.findAll('.upload-name').map((n) => n.text())).toEqual(['Album/x.txt', 'Album/2026/y.txt']);
  });

  it('a dropped folder is walked recursively, in portions, with its path below the drop target', async () => {
    type Fake = { isFile: boolean; isDirectory: boolean; name: string; file?: (ok: (f: File) => void) => void; createReader?: () => unknown };
    const file = (name: string): Fake => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(new File(['x'], name)) });
    const dir = (name: string, ...portions: Fake[][]): Fake => ({ isFile: false, isDirectory: true, name, createReader: () => {
      const queue = [...portions, []];
      return { readEntries: (ok: (e: Fake[]) => void) => ok(queue.shift()!) };
    } });
    const tree = [dir('Album', [file('a.jpg'), dir('2026', [file('b.jpg')])], [file('c.jpg')]), file('top.txt')];
    const got = await walkEntries(tree as unknown as FileSystemEntry[]);
    expect(got.map((g) => g.rel)).toEqual(['Album/a.jpg', 'Album/2026/b.jpg', 'Album/c.jpg', 'top.txt']);
  });
});
