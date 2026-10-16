import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { createMemoryHistory, createRouter } from 'vue-router';
import en from '../src/i18n/en.json';
import App from '../src/App.vue';
import { routes } from '../src/router.ts';

// Upload behaviour of the folder view and the upload panel is in uploads.test.ts.

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const me = { id: 'u', displayName: 'Test User', role: 'admin', csrfToken: 'tok', settings: { locale: null, theme: 'system' },
  sort: { key: 'name', dir: 'asc' } };
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
