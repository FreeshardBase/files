// Markdown preview (#142): markdown-it parses, and this module turns its tokens into Vue nodes itself. No HTML string
// is ever handed to the browser (`v-html` is banned), so the output can only contain the elements built below.
import MarkdownIt from 'markdown-it';
import { h, type VNodeArrayChildren } from 'vue';

type Token = ReturnType<InstanceType<typeof MarkdownIt>['parse']>[number];

// `html: false`: raw HTML in the source is plain text to the parser. markdown-it's own link check already drops
// `javascript:`, `vbscript:`, `file:` and `data:` URLs; `safeHref` below narrows that further.
const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

// Containers the renderer creates; any other tag from a token is left out and only its content kept.
const TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'em', 'strong', 's']);

/** Absolute http(s) and mailto only. A relative link has nothing to point at inside the preview. */
const safeHref = (href: string | number | null): string | null =>
  (typeof href === 'string' && /^(https?:|mailto:)/i.test(href) ? href : null);
const linkProps = (href: string) => ({ href, target: '_blank', rel: 'noopener noreferrer nofollow' });

type Frame = { tag: string | null; props: Record<string, unknown>; children: VNodeArrayChildren };

function open(tok: Token): Frame {
  const frame: Frame = { tag: TAGS.has(tok.tag) ? tok.tag : null, props: {}, children: [] };
  if (tok.type === 'paragraph_open' && tok.hidden) frame.tag = null; // tight list item: no <p>
  if (tok.type === 'ordered_list_open') {
    const start = Number(tok.attrGet('start') ?? 1);
    if (Number.isSafeInteger(start) && start !== 1) frame.props.start = start;
  }
  if (tok.type === 'th_open' || tok.type === 'td_open') {
    const align = /text-align:(left|center|right)/.exec(String(tok.attrGet('style') ?? ''))?.[1];
    if (align) frame.props.class = `align-${align}`;
  }
  if (tok.type === 'link_open') {
    const href = safeHref(tok.attrGet('href'));
    if (href) Object.assign(frame, { tag: 'a', props: linkProps(href) });
  }
  return frame;
}

function leaf(tok: Token, imageLabel: (alt: string) => string): VNodeArrayChildren {
  switch (tok.type) {
    case 'inline': return walk(tok.children ?? [], imageLabel);
    case 'text': return [tok.content];
    case 'code_inline': return [h('code', tok.content)];
    case 'softbreak': return ['\n'];
    case 'hardbreak': return [h('br')];
    case 'hr': return [h('hr')];
    case 'fence': case 'code_block': return [h('pre', [h('code', tok.content.replace(/\n$/, ''))])];
    case 'image': {
      // Never an <img>: a remote image would be fetched as soon as the file is opened. The alt text stands in for it.
      const label = imageLabel(tok.content);
      const href = safeHref(tok.attrGet('src'));
      return [href && !href.startsWith('mailto:') ? h('a', linkProps(href), label) : h('span', { class: 'md-image' }, label)];
    }
    // Raw HTML only reaches here if the parser is ever configured to emit it: it stays text.
    default: return tok.content ? [tok.content] : [];
  }
}

function walk(tokens: Token[], imageLabel: (alt: string) => string): VNodeArrayChildren {
  const stack: Frame[] = [{ tag: null, props: {}, children: [] }];
  for (const tok of tokens) {
    const top = stack[stack.length - 1]!;
    if (tok.nesting === 1) { stack.push(open(tok)); continue; }
    if (tok.nesting === -1) {
      const f = stack.pop()!;
      const parent = stack[stack.length - 1]!;
      if (f.tag) parent.children.push(h(f.tag, f.props, f.children));
      else parent.children.push(...f.children);
      continue;
    }
    top.children.push(...leaf(tok, imageLabel));
  }
  return stack[0]!.children;
}

/** The rendered document as Vue nodes. `imageLabel` turns an image's alt text into the text shown in its place. */
export function renderMarkdown(source: string, imageLabel: (alt: string) => string): VNodeArrayChildren {
  return walk(md.parse(source, {}), imageLabel);
}
