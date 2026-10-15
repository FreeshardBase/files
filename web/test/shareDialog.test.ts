import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import en from '../src/i18n/en.json';
import ShareDialog from '../src/components/ShareDialog.vue';

// #146: the share dialog's member picker and its requests, against a stubbed server.
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });
const entry = { name: 'Fotos', path: '/Fotos', type: 'directory' as const, size: 0, modified: '2026-10-14T00:00:00.000Z' };
const members = [{ id: 'u2', displayName: 'Second Member' }, { id: 'u3', displayName: 'Test Member' }];
const mounted: VueWrapper[] = [];
afterEach(() => { for (const w of mounted.splice(0)) w.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
const tick = () => new Promise((r) => setTimeout(r, 0));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function server() {
  const shares: { id: string; grantee: { id: string; displayName: string }; access: string; createdAt: string }[] = [];
  const calls: { method: string; url: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url === '/api/v1/members') return json({ items: members });
    if (url.startsWith('/api/v1/shares?')) return json({ items: shares });
    if (url === '/api/v1/shares' && method === 'POST') {
      const b = JSON.parse(String(init.body));
      const s = { id: `s-${b.grantee}`, grantee: members.find((m) => m.id === b.grantee)!, access: b.access, createdAt: '2026-10-15T00:00:00.000Z' };
      shares.push(s);
      return json(s, 201);
    }
    if (method === 'DELETE') { shares.splice(0); return new Response(null, { status: 204 }); }
    return json({ code: 'NOT_FOUND' }, 404);
  }));
  return { calls, shares };
}

async function open() {
  const w = mount(ShareDialog, { props: { source: 'home', entry }, attachTo: document.body, global: { plugins: [i18n] } });
  mounted.push(w);
  await tick(); await tick();
  const input = document.querySelector<HTMLInputElement>('[role=combobox]')!;
  const type = async (v: string) => { input.value = v; input.dispatchEvent(new Event('input')); await tick(); };
  const key = async (k: string) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    input.dispatchEvent(e); await tick(); return e;
  };
  const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role=option]'))
    .filter((o) => (o.parentElement as HTMLElement).style.display !== 'none').map((o) => o.textContent!.trim());
  return { w, input, type, key, options };
}

describe('ShareDialog', () => {
  it('starts in the member field and filters the members by name, ignoring case', async () => {
    server();
    const d = await open();
    expect(document.activeElement).toBe(d.input);
    await d.type('second');
    expect(d.options()).toEqual(['Second Member']);
    await d.type('MEM');
    expect(d.options()).toEqual(['Second Member', 'Test Member']);
    await d.type('zzz');
    expect(d.options()).toEqual([]);
    expect(document.body.textContent).toContain('No member matches “zzz”.');
  });

  it('arrow keys move the active option, Enter picks it, and Esc in the open list closes only the list', async () => {
    server();
    const d = await open();
    await d.type('mem');
    await d.key('ArrowDown'); await d.key('ArrowDown');
    const active = d.input.getAttribute('aria-activedescendant');
    expect(document.getElementById(active!)!.textContent!.trim()).toBe('Test Member');
    await d.key('ArrowUp');
    const esc = await d.key('Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(d.w.emitted('close')).toBeUndefined();
    expect(d.options()).toEqual([]);
    await d.key('ArrowDown'); await d.key('ArrowDown');
    await d.key('Enter');
    expect(d.input.value).toBe('Test Member');
    expect(d.options()).toEqual([]);
    // With the list closed, Esc is the dialog's: it closes.
    await d.key('Escape');
    expect(d.w.emitted('close')).toHaveLength(1);
  });

  it('shares with the picked member\'s id and the chosen access, never naming an owner, then lists the member', async () => {
    const s = server();
    const d = await open();
    expect(document.body.textContent).toContain('Only you.');
    await d.type('test');
    await d.key('Enter');
    document.querySelector<HTMLInputElement>('input[type=radio][value=edit]')!.click();
    await tick();
    document.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(); await tick();
    expect(s.calls.find((c) => c.method === 'POST')!.body).toEqual({ source: 'home', path: '/Fotos', grantee: 'u3', access: 'edit' });
    const who = document.querySelector('.share-list')!;
    expect(who.textContent).toContain('Test Member');
    expect(who.textContent).toContain('Can edit');
    expect(d.input.value).toBe('');

    document.querySelector<HTMLButtonElement>('[aria-label="Remove access for Test Member"]')!.click();
    await tick(); await tick();
    expect(s.calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/shares/s-u3')).toBe(true);
    expect(document.querySelector('.share-list')).toBeNull();
  });

  it('asks to pick a member from the list when the text names none', async () => {
    const s = server();
    await open();
    document.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(document.querySelector('[role=alert]')!.textContent).toContain('Choose a member from the list.');
    expect(s.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
