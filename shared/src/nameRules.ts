import { z } from 'zod';

/**
 * The name rules of each kind of source (#342), beyond the universal ones every source has (no `/`, `\`, `.`, `..`,
 * control characters, at most 255 bytes; storage/resolveInRoot.ts). Each backend declares its set; the server checks
 * every target name against it before writing, and the web checks the same way before sending, so a name a provider
 * would refuse is asked about (or, in an unattended job, replaced) instead of failing at the provider.
 *
 * The suggestion replaces forbidden characters with `_` (as OneDrive's own "Rename" does), trims what may not lead or
 * trail, appends `_` to a reserved name and shortens a too-long path in the middle of the name, keeping the extension.
 */
export const NAME_RULE_SETS = ['universal', 'onedrive', 'sharepoint', 'dropbox'] as const;
export const NameRuleSet = z.enum(NAME_RULE_SETS);
export type NameRuleSet = z.infer<typeof NameRuleSet>;

export const NAME_ISSUES = ['char', 'control', 'leadingSpace', 'trailingSpace', 'trailingDot', 'reserved', 'tildeDollar', 'vti', 'pathLength'] as const;
/** One reason a name is not allowed; `char` names the forbidden character. */
export const NameIssue = z.object({ code: z.enum(NAME_ISSUES), char: z.string().optional() }).strict();
export type NameIssue = z.infer<typeof NameIssue>;

/** Microsoft's limit on a whole path in OneDrive and SharePoint, in characters. */
export const GRAPH_MAX_PATH = 400;
const GRAPH_CHARS = new Set(['"', '*', ':', '<', '>', '?', '\\', '|']);
const DEVICES = new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 10 }, (_, n) => [`COM${n}`, `LPT${n}`]).flat()]);
const RESERVED_WHOLE = new Set(['.lock', 'desktop.ini']);
// eslint-disable-next-line no-control-regex -- the control characters are what this matches
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const isGraph = (set: NameRuleSet) => set === 'onedrive' || set === 'sharepoint';
/** The length of `dir/` in front of a name, in characters. */
const prefixLength = (dir: string) => (dir === '/' ? 1 : dir.length + 1);
/** A reserved device name (with any extension: `CON.txt`), `.lock` or `desktop.ini`. */
const reserved = (name: string) => DEVICES.has(name.split('.')[0]!.toUpperCase()) || RESERVED_WHOLE.has(name.toLowerCase());

/** Why `name` may not be created in the folder `dir` of a source with these rules; empty if it may. */
export function checkName(set: NameRuleSet, name: string, dir = '/'): NameIssue[] {
  const issues: NameIssue[] = [];
  if (set === 'universal') return issues;
  const graph = isGraph(set);
  if (graph) {
    const seen = new Set<string>();
    for (const c of name) if (GRAPH_CHARS.has(c) && !seen.has(c)) { seen.add(c); issues.push({ code: 'char', char: c }); }
  }
  if (CONTROL.test(name)) issues.push({ code: 'control' });
  if (graph && name.startsWith(' ')) issues.push({ code: 'leadingSpace' });
  if (name.endsWith(' ')) issues.push({ code: 'trailingSpace' });
  else if (name.endsWith('.')) issues.push({ code: 'trailingDot' });
  if (!graph) return issues;
  if (reserved(name)) issues.push({ code: 'reserved' });
  if (name.startsWith('~$')) issues.push({ code: 'tildeDollar' });
  if (name.toLowerCase().includes('_vti_')) issues.push({ code: 'vti' });
  if (prefixLength(dir) + name.length > GRAPH_MAX_PATH) issues.push({ code: 'pathLength' });
  return issues;
}

/**
 * The name offered instead of `name`, and the positions (in code points of the suggestion) of every character that was
 * replaced or added, which the dialog highlights. A name that is allowed comes back unchanged.
 */
export function suggestName(set: NameRuleSet, name: string, dir = '/'): { name: string; replaced: number[] } {
  if (!checkName(set, name, dir).length) return { name, replaced: [] };
  const graph = isGraph(set);
  let cs = [...name].map((c) => ({ c, mark: false }));
  const text = () => cs.map((x) => x.c).join('');
  if (graph) while (cs[0]?.c === ' ') cs.shift();
  while (cs.at(-1)?.c === ' ' || cs.at(-1)?.c === '.') cs.pop();
  cs = cs.map((x) => (CONTROL.test(x.c) || (graph && GRAPH_CHARS.has(x.c)) ? { c: '_', mark: true } : x));
  if (graph) {
    if (cs[0]?.c === '~' && cs[1]?.c === '$') cs[0] = { c: '_', mark: true };
    // `_vti_` loses its closing underscore, as often as it occurs.
    for (let at = text().toLowerCase().indexOf('_vti_'); at >= 0; at = text().toLowerCase().indexOf('_vti_')) {
      cs[[...text().slice(0, at)].length + 4] = { c: '-', mark: true };
    }
    if (reserved(text())) {
      const whole = RESERVED_WHOLE.has(text().toLowerCase());
      const stem = whole ? cs.length : cs.findIndex((x) => x.c === '.') === -1 ? cs.length : cs.findIndex((x) => x.c === '.');
      cs.splice(stem, 0, { c: '_', mark: true });
    }
  }
  if (!cs.length) cs = [{ c: '_', mark: true }];
  if (graph && prefixLength(dir) + text().length > GRAPH_MAX_PATH) cs = shorten(cs, GRAPH_MAX_PATH - prefixLength(dir));
  return { name: text(), replaced: cs.flatMap((x, i) => (x.mark ? [i] : [])) };
}

/** Cuts the middle of the stem (marked with `…`) until the name fits `room` characters; the extension stays. */
function shorten<T extends { c: string; mark: boolean }>(cs: T[], room: number): T[] {
  const length = (xs: T[]) => xs.reduce((n, x) => n + x.c.length, 0);
  const dot = cs.map((x) => x.c).lastIndexOf('.');
  const ext = dot > 0 ? cs.slice(dot) : [];
  const stem = dot > 0 ? cs.slice(0, dot) : cs;
  const keep = room - length(ext) - 1;
  if (keep < 2) return cs; // no room for a name at all: the check still fails and says why
  const head = stem.slice(0, Math.ceil(keep / 2));
  const tail = stem.slice(stem.length - Math.floor(keep / 2));
  return [...head, { c: '…', mark: true } as T, ...tail, ...ext];
}

/** Sources whose names ignore case: there an existing `a.txt` takes the name `A.txt`. */
export const ignoresCase = (set: NameRuleSet) => set !== 'universal';

/** Whether `name` is taken by one of `names` in a source with these rules (a collision). */
export function nameTaken(set: NameRuleSet, name: string, names: Iterable<string>): boolean {
  const key = ignoresCase(set) ? name.toLowerCase() : name;
  for (const n of names) if ((ignoresCase(set) ? n.toLowerCase() : n) === key) return true;
  return false;
}
