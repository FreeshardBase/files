import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import type { Comment } from '@files/shared';
import en from '../src/i18n/en.json';
import CommentThread from '../src/components/CommentThread.vue';

// #213: the composer's keys and the text rules of the comment thread, against a stubbed server. Enter sends, Shift+Enter
// and an IME's Enter do not; text the server would refuse is refused before a request; Esc while editing stays in the
// thread and does not reach the drawer.
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });
const mounted: VueWrapper[] = [];
const tick = () => new Promise((r) => setTimeout(r, 0));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const comment = (id: number, text: string, mine = true): Comment => ({ id, author: { id: 'u', displayName: 'Test User' }, text,
  created: '2026-10-17T08:00:00.000Z', edited: null, mine, canDelete: mine });

let posts: unknown[];
beforeEach(() => {
  setActivePinia(createPinia());
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) as { text: string } : undefined;
    if (url === '/api/v1/comments' && init.method === 'POST') { posts.push(body); return json(comment(9, body!.text), 201); }
    if (url === '/api/v1/comments/1' && init.method === 'PATCH') return json({ ...comment(1, body!.text), edited: '2026-10-17T09:00:00.000Z' });
    return json({ code: 'NOT_FOUND' }, 404);
  }));
});
afterEach(() => { for (const w of mounted.splice(0)) w.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

function open(comments: Comment[] = []) {
  const w = mount(CommentThread, { props: { source: 'share:abc', path: '/plan.txt', name: 'plan.txt', comments },
    attachTo: document.body, global: { plugins: [i18n] } });
  mounted.push(w);
  return w;
}
async function press(el: Element, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  await tick(); await tick();
  return e;
}

describe('the comment composer', () => {
  it('sends on Enter, keeps Shift+Enter and an IME composition as a new line', async () => {
    const w = open();
    const field = w.get<HTMLTextAreaElement>('textarea');
    field.element.focus();
    await field.setValue('first line');
    expect((await press(field.element, { key: 'Enter', shiftKey: true })).defaultPrevented).toBe(false);
    expect((await press(field.element, { key: 'Enter', isComposing: true })).defaultPrevented).toBe(false);
    expect(posts).toEqual([]);

    await field.setValue('first line\nsecond line');
    expect((await press(field.element, { key: 'Enter' })).defaultPrevented).toBe(true);
    expect(posts).toEqual([{ source: 'share:abc', path: '/plan.txt', text: 'first line\nsecond line' }]);
    expect(w.emitted('update:comments')).toEqual([[[comment(9, 'first line\nsecond line')]]]);
    expect(field.element.value).toBe('');
    expect(document.activeElement).toBe(field.element);
    expect(w.get('[role=status]').text()).toBe('Comment sent.');
  });

  it('refuses empty, too long and control-character text before any request', async () => {
    const w = open();
    const field = w.get<HTMLTextAreaElement>('textarea');
    for (const bad of ['   ', 'x'.repeat(4001), 'a\u0007b']) {
      await field.setValue(bad);
      await press(field.element, { key: 'Enter' });
      expect(w.get('[role=alert]').text(), bad).toBe('A comment needs text of at most 4000 characters, without control characters.');
    }
    expect(posts).toEqual([]);
  });

  it('renders the text as text and edits a comment in place; Esc cancels the edit without reaching the drawer', async () => {
    const w = open([comment(1, '<b>bold</b>\nnext'), comment(2, 'theirs', false)]);
    expect(w.findAll('.comment-text').map((p) => p.element.textContent)).toEqual(['<b>bold</b>\nnext', 'theirs']);
    expect(w.find('.comment-text b').exists()).toBe(false);
    // Someone else's comment offers neither edit nor delete.
    expect(w.findAll('.comment')[1]!.findAll('button')).toHaveLength(0);

    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    try {
      await w.get('[data-edit="1"]').trigger('click');
      await tick();
      const edit = w.get<HTMLTextAreaElement>('[data-edit-field="1"]');
      expect(document.activeElement).toBe(edit.element);
      await press(edit.element, { key: 'Escape' });
      expect(outside).not.toHaveBeenCalled();
      expect(w.find('[data-edit-field="1"]').exists()).toBe(false);
      expect(document.activeElement).toBe(w.get('[data-edit="1"]').element);

      await w.get('[data-edit="1"]').trigger('click');
      await tick();
      const again = w.get<HTMLTextAreaElement>('[data-edit-field="1"]');
      await again.setValue('fixed');
      await press(again.element, { key: 'Enter' });
      expect(w.emitted('update:comments')!.at(-1)).toEqual([[{ ...comment(1, 'fixed'), edited: '2026-10-17T09:00:00.000Z' }, comment(2, 'theirs', false)]]);
    } finally { document.removeEventListener('keydown', outside); }
  });
});
