import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { createMemoryHistory, createRouter } from 'vue-router';
import en from '../src/i18n/en.json';
import App from '../src/App.vue';
import { installFakeXhr } from './fakeXhr.ts';
import { routes } from '../src/router.ts';
import FolderView from '../src/views/FolderView.vue';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const me = { id: 'u', displayName: 'Test User', role: 'admin', csrfToken: 'tok' };
const i18n = () => createI18n({ legacy: false, locale: 'en', messages: { en } });
const mk = () => {
  const router = createRouter({ history: createMemoryHistory(), routes });
  return router;
};

beforeEach(() => { setActivePinia(createPinia()); });

describe('startup failure', () => {
  it('shows an alert with the error text and retries /me on demand', async () => {
    let ok = false;
    const f = vi.fn(async (url: string) => (String(url).includes('/list') ? json({ entries: [] }) : ok ? json(me) : json({ code: 'INTERNAL' }, 500)));
    vi.stubGlobal('fetch', f);
    const router = mk(); await router.push('/');
    const w = mount(App, { global: { plugins: [i18n(), router] } });
    await flushPromises();
    expect(w.find('[role=alert]').text()).toBe(en.errors.INTERNAL);
    ok = true;
    await w.find('button').trigger('click');
    await flushPromises();
    expect(w.find('[role=alert]').exists()).toBe(false);
    expect(f.mock.calls.filter(([u]) => String(u).includes('/api/v1/me'))).toHaveLength(2);
  });
});

describe('failed login', () => {
  it('shows LOGIN_FAILED with a sign-in-again link instead of redirecting to login', async () => {
    const loc = { href: 'http://x/home?loginError=1', pathname: '/home', search: '?loginError=1' };
    vi.stubGlobal('location', loc);
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'UNAUTHENTICATED' }, 401)));
    const router = mk(); await router.push('/?loginError=1');
    const w = mount(App, { global: { plugins: [i18n(), router] } });
    await flushPromises();
    expect(w.find('[role=alert]').text()).toBe(en.errors.LOGIN_FAILED);
    expect(router.currentRoute.value.fullPath).toBe('/home');
    const again = w.find('a[href="/auth/login"]');
    expect(again.text()).toBe(en.app.signInAgain);
    expect(loc.href).toBe('http://x/home?loginError=1');
    vi.unstubAllGlobals();
  });
});

describe('FolderView uploads', () => {
  it('summarises a mixed batch, lists the failure, relists exactly once, keeps the list mounted', async () => {
    const listCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      listCalls.push(url);
      return json({ entries: [{ name: 'old', path: '/old', type: 'file', size: 1, modified: '2026-10-14T00:00:00.000Z' }] });
    }));
    installFakeXhr((url) => new URL(url, 'http://x').searchParams.get('path') === '/b.txt'
      ? { status: 507, text: '{"code":"STORAGE_FULL"}' }
      : { status: 201, text: '{}' });
    const router = mk(); await router.push('/');
    const w = mount(FolderView, { global: { plugins: [i18n(), router] } });
    await flushPromises();
    expect(listCalls).toHaveLength(1);
    const files = ['a.txt', 'b.txt', 'c.txt'].map((n) => new File(['x'], n));
    const input = w.find('input[type=file]');
    Object.defineProperty(input.element, 'files', { value: files, configurable: true });
    await input.trigger('change');
    await flushPromises();
    expect(w.find('[role=status]').text()).toBe('2 of 3 uploaded');
    expect(w.find('.upload-failures').text()).toContain(`b.txt: ${en.errors.STORAGE_FULL}`);
    expect(listCalls).toHaveLength(2);
    expect(w.find('table').exists()).toBe(true);
  });
  it('clears status and failures when the folder changes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ entries: [] })));
    installFakeXhr(() => ({ status: 507, text: '{"code":"STORAGE_FULL"}' }));
    const router = mk(); await router.push('/home/A');
    const w = mount(FolderView, { global: { plugins: [i18n(), router] } });
    await flushPromises();
    const input = w.find('input[type=file]');
    Object.defineProperty(input.element, 'files', { value: [new File(['x'], 'a.txt')], configurable: true });
    await input.trigger('change');
    await flushPromises();
    expect(w.find('[role=status]').text()).toBe('0 of 1 uploaded');
    expect(w.find('.upload-failures').exists()).toBe(true);
    await router.push('/home/B');
    await flushPromises();
    expect(w.find('[role=status]').text()).toBe('');
    expect(w.find('.upload-failures').exists()).toBe(false);
  });
  it('asks on FILE_EXISTS, resends with the chosen policy, and "apply to all" asks once', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ entries: [] })));
    const x = installFakeXhr((url) => {
      const u = new URL(url, 'http://x');
      return u.searchParams.get('onCollision') === 'fail'
        ? { status: 409, text: JSON.stringify({ code: 'FILE_EXISTS', params: { name: u.searchParams.get('path')!.slice(1) } }) }
        : { status: 201, text: '{}' };
    });
    const router = mk(); await router.push('/home');
    const w = mount(FolderView, { attachTo: document.body, global: { plugins: [i18n(), router] } });
    await flushPromises();
    const input = w.find('input[type=file]');
    Object.defineProperty(input.element, 'files', { value: ['a.txt', 'b.txt', 'c.txt'].map((n) => new File(['x'], n)), configurable: true });
    void input.trigger('change');
    await flushPromises();
    const dialogs = () => document.querySelectorAll('[role="dialog"]');
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0]!.textContent).toContain('a.txt');
    const button = (label: string) => [...dialogs()[0]!.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
    button(en.collision.keepBoth).click(); // this item only
    await flushPromises();
    expect(dialogs()[0]!.textContent).toContain('b.txt');
    dialogs()[0]!.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
    await flushPromises();
    button(en.collision.replace).click();
    await flushPromises();
    expect(dialogs()).toHaveLength(0);
    const sent = x.puts.map((p) => { const u = new URL(p.url, 'http://x'); return `${u.searchParams.get('path')}:${u.searchParams.get('onCollision')}`; });
    expect(sent).toEqual(['/a.txt:fail', '/a.txt:keep-both', '/b.txt:fail', '/b.txt:replace', '/c.txt:replace']);
    expect(w.find('[role=status]').text()).toBe('3 of 3 uploaded');
    w.unmount();
  });
  it('skip counts as skipped, not failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ entries: [] })));
    installFakeXhr(() => ({ status: 409, text: '{"code":"FILE_EXISTS","params":{"name":"a.txt"}}' }));
    const router = mk(); await router.push('/home');
    const w = mount(FolderView, { attachTo: document.body, global: { plugins: [i18n(), router] } });
    await flushPromises();
    const input = w.find('input[type=file]');
    Object.defineProperty(input.element, 'files', { value: [new File(['x'], 'a.txt')], configurable: true });
    void input.trigger('change');
    await flushPromises();
    [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === en.collision.skip)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    expect(w.find('[role=status]').text()).toBe('0 of 1 uploaded, 1 skipped');
    expect(w.find('.upload-failures').exists()).toBe(false);
    w.unmount();
  });
  it('keeps uploading to the original folder when the route changes mid-batch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ entries: [] })));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const x = installFakeXhr(async () => { await gate; return { status: 201, text: '{}' }; });
    const router = mk(); await router.push('/home/A');
    const w = mount(FolderView, { global: { plugins: [i18n(), router] } });
    await flushPromises();
    const files = ['1.txt', '2.txt'].map((n) => new File(['x'], n));
    const input = w.find('input[type=file]');
    Object.defineProperty(input.element, 'files', { value: files, configurable: true });
    const done = input.trigger('change');
    await router.push('/home/B');
    await flushPromises();
    release();
    await done;
    await flushPromises();
    expect(x.puts.map((p) => new URL(p.url, 'http://x').searchParams.get('path'))).toEqual(['/A/1.txt', '/A/2.txt']);
  });
});
