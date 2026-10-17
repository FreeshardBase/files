// @vitest-environment node
// #295: ad blockers hide every element whose class a generic cosmetic rule names (Brave hid the share dialog's lists
// through `##.share-list` and `##.share-heading`). No class the SPA renders or styles may match such a rule.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse } from 'vue/compiler-sfc';

const root = fileURLToPath(new URL('../..', import.meta.url));
const src = join(root, 'web/src');
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);

/** The classes `##.<class>` rules of the vendored fixture hide. */
const blocked = readFileSync(join(root, 'e2e/fixtures/generic-cosmetic-rules.txt'), 'utf8').split('\n')
  .map((l) => /^##\.([\w-]+)$/.exec(l.trim())?.[1]).filter((c): c is string => !!c);

type Node = { type: number; props?: Prop[]; children?: Node[] };
type Prop = { type: number; name: string; value?: { content: string }; arg?: { content: string }; exp?: { content: string } };
/** Static `class` values and the literals and object keys of `:class` bindings in a template. */
function templateClasses(n: Node, out: Set<string>) {
  for (const p of n.props ?? []) {
    if (p.type === 6 && p.name === 'class') p.value?.content.split(/\s+/).forEach((c) => c && out.add(c));
    if (p.type === 7 && p.name === 'bind' && p.arg?.content === 'class' && p.exp) {
      for (const m of p.exp.content.matchAll(/'([^']*)'|"([^"]*)"|`([^`$]*)`|([\w-]+)\s*:/g)) {
        (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').split(/\s+/).forEach((c) => c && out.add(c));
      }
    }
  }
  for (const c of n.children ?? []) templateClasses(c, out);
}

function usedClasses(): Map<string, string> {
  const where = new Map<string, string>();
  for (const f of files(src)) {
    const found = new Set<string>();
    if (f.endsWith('.vue')) {
      const ast = parse(readFileSync(f, 'utf8'), { filename: f }).descriptor.template?.ast;
      if (ast) templateClasses(ast as unknown as Node, found);
    } else if (f.endsWith('.css')) {
      const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/g, '');
      for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) found.add(m[1]!);
    }
    for (const c of found) where.set(c, f.slice(root.length));
  }
  return where;
}

describe('class names and generic cosmetic filter rules', () => {
  it('reads the fixture and finds the classes the SPA uses', () => {
    expect(blocked).toEqual(expect.arrayContaining(['share-list', 'share-heading']));
    const used = usedClasses();
    expect(used.has('fs-field__error')).toBe(true);
    expect(used.has('app-dialog')).toBe(true);
  });
  it('no class used in web/src is hidden by a generic rule', () => {
    const used = usedClasses();
    expect(blocked.filter((c) => used.has(c)).map((c) => `${c} (${used.get(c)})`)).toEqual([]);
  });
});
