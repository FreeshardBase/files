import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import en from '../src/i18n/en.json';
import MarkdownView from '../src/components/MarkdownView.vue';

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });
const render = (source: string) => mount(MarkdownView, { props: { source }, global: { plugins: [i18n] } });

describe('MarkdownView', () => {
  it('renders CommonMark structure as elements', () => {
    const w = render('# Title\n\nSome *em* and **strong** and `code`.\n\n- one\n- two\n\n3. three\n\n> quote\n\n```\nfenced <b>\n```\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n');
    expect(w.find('h1').text()).toBe('Title');
    expect(w.find('em').text()).toBe('em');
    expect(w.find('strong').text()).toBe('strong');
    expect(w.find('p code').text()).toBe('code');
    expect(w.findAll('ul > li').map((li) => li.text())).toEqual(['one', 'two']);
    expect(w.find('ol').attributes('start')).toBe('3');
    expect(w.find('blockquote p').text()).toBe('quote');
    expect(w.find('pre code').text()).toBe('fenced <b>');
    expect(w.find('pre code b').exists()).toBe(false);
    expect(w.findAll('th').map((x) => x.text())).toEqual(['a', 'b']);
    expect(w.findAll('td')[1]!.classes()).toContain('align-right');
  });

  it('shows raw HTML as text and creates no element from it', () => {
    const src = '<script>window.pwned = 1</script>\n\nText <img src=x onerror="window.pwned = 2"> and <a href="javascript:alert(1)">x</a>\n\n<div onclick="x()">block</div>\n';
    const w = render(src);
    expect(w.find('script').exists()).toBe(false);
    expect(w.find('img').exists()).toBe(false);
    expect(w.find('div[onclick]').exists()).toBe(false);
    expect(w.find('a').exists()).toBe(false);
    expect(w.text()).toContain('<script>window.pwned = 1</script>');
    expect(w.text()).toContain('<img src=x onerror="window.pwned = 2">');
    expect(w.html()).not.toMatch(/<(script|img|div)\b[^>]*on\w+=/);
  });

  it('never loads an image: it becomes its alt text, linked only for http(s)', () => {
    const w = render('![A cat](https://example.com/cat.png) ![Local](./x.png)');
    expect(w.find('img').exists()).toBe(false);
    const links = w.findAll('a');
    expect(links.map((a) => a.attributes('href'))).toEqual(['https://example.com/cat.png']);
    expect(links[0]!.text()).toBe('Image: A cat');
    expect(w.text()).toContain('Image: Local');
  });

  it('keeps only safe links, opened in a new tab without referrer', () => {
    const w = render('[ok](https://example.com/a) [mail](mailto:testuser@example.com) [js](javascript:alert(1)) [data](data:text/html,x) [rel](other.md)');
    const links = w.findAll('a');
    expect(links.map((a) => a.attributes('href'))).toEqual(['https://example.com/a', 'mailto:testuser@example.com']);
    for (const a of links) {
      expect(a.attributes('target')).toBe('_blank');
      expect(a.attributes('rel')).toBe('noopener noreferrer nofollow');
    }
    expect(w.text()).toContain('js');
    expect(w.text()).toContain('rel');
  });
});
