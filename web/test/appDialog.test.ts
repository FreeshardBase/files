import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { defineComponent, h, ref } from 'vue';
import en from '../src/i18n/en.json';
import AppDialog from '../src/components/AppDialog.vue';
import CollisionDialog from '../src/components/CollisionDialog.vue';

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });
const mounted: VueWrapper[] = [];
afterEach(() => { for (const w of mounted.splice(0)) w.unmount(); document.body.innerHTML = ''; });

// A page with a button behind the dialog; the dialog shows while `open` is true.
function page(opts: { returnFocus?: boolean } = {}) {
  const open = ref(false); const closed = ref(0);
  const back = ref<HTMLButtonElement>();
  const Host = defineComponent({
    setup: () => () => h('div', [
      h('button', { ref: back, id: 'behind' }, 'behind'),
      open.value ? h(AppDialog, { title: 'Pick one', returnFocus: opts.returnFocus ? back.value : undefined, onClose: () => { closed.value++; open.value = false; } }, {
        default: () => h('p', 'body'),
        actions: () => [h('button', { id: 'one' }, 'one'), h('button', { id: 'two', 'data-autofocus': '' }, 'two'), h('button', { id: 'three' }, 'three')],
      }) : null,
    ]),
  });
  const w = mount(Host, { attachTo: document.body, global: { plugins: [i18n] } });
  mounted.push(w);
  return { w, open, closed, back };
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const tick = () => new Promise((r) => setTimeout(r, 0));
const key = (k: string, shift = false) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }));

describe('AppDialog', () => {
  it('is a labelled modal dialog and moves focus into it', async () => {
    const p = page(); p.open.value = true; await tick();
    const d = dialog()!;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)!.textContent).toBe('Pick one');
    expect(document.activeElement?.id).toBe('two');
  });
  it('wraps Tab and Shift+Tab inside the dialog', async () => {
    const p = page(); p.open.value = true; await tick();
    document.getElementById('three')!.focus();
    key('Tab');
    expect(document.activeElement?.id).toBe('one');
    key('Tab', true);
    expect(document.activeElement?.id).toBe('three');
  });
  it('pulls focus back when it lands outside', async () => {
    const p = page(); p.open.value = true; await tick();
    document.getElementById('behind')!.focus();
    expect(dialog()!.contains(document.activeElement)).toBe(true);
  });
  it('Esc asks to close; closing restores focus to the given element', async () => {
    const p = page({ returnFocus: true }); p.open.value = true; await tick();
    key('Escape'); await tick();
    expect(p.closed.value).toBe(1);
    expect(dialog()).toBeNull();
    expect(document.activeElement?.id).toBe('behind');
  });
  it('restores focus to the previously focused element without returnFocus', async () => {
    const p = page(); document.getElementById('behind')!.focus();
    p.open.value = true; await tick();
    expect(document.activeElement?.id).toBe('two');
    p.open.value = false; await tick();
    expect(document.activeElement?.id).toBe('behind');
  });
  it('locks page scroll and makes the background inert while open', async () => {
    const p = page(); p.open.value = true; await tick();
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(p.w.element.closest('[inert]')).not.toBeNull();
    p.open.value = false; await tick();
    expect(document.documentElement.style.overflow).toBe('');
    expect(p.w.element.closest('[inert]')).toBeNull();
  });
});

describe('CollisionDialog', () => {
  const mk = (remaining: number) => {
    const w = mount(CollisionDialog, { props: { name: 'a.txt', remaining }, attachTo: document.body, global: { plugins: [i18n] } });
    mounted.push(w); return w;
  };
  const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
  it('names the conflicting item and emits each choice', async () => {
    const w = mk(0); await tick();
    expect(dialog()!.textContent).toContain('a.txt');
    button(en.collision.replace).click();
    button(en.collision.keepBoth).click();
    button(en.collision.skip).click();
    expect(w.emitted('choose')).toEqual([[{ policy: 'replace', all: false }], [{ policy: 'keep-both', all: false }], [{ policy: 'skip', all: false }]]);
  });
  it('offers "apply to all" only when items remain, and passes it on', async () => {
    const w = mk(2); await tick();
    const box = dialog()!.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    box.click(); await tick();
    button(en.collision.skip).click();
    expect(w.emitted('choose')).toEqual([[{ policy: 'skip', all: true }]]);
    w.unmount(); mounted.length = 0;
    mk(0); await tick();
    expect(dialog()!.querySelector('input[type=checkbox]')).toBeNull();
  });
  it('Esc skips this item only', async () => {
    const w = mk(2); await tick();
    key('Escape');
    expect(w.emitted('choose')).toEqual([[{ policy: 'skip', all: false }]]);
  });
});
