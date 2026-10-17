import { z } from 'zod';

/**
 * Batch rename (#215): the operations, the plan that turns a folder's selected names into new ones, and the checks of a
 * new name. The server computes the plan for the preview and again for the job, from the same inputs, so what the
 * preview shows is what the job does. Everything is literal text: no regular expressions (#121).
 */

/** Items renamed in one batch at most. */
export const MAX_RENAME_ITEMS = 1000;
/** A name's length limit in UTF-8 bytes, as every filesystem and provider the app uses has it. */
export const MAX_NAME_BYTES = 255;

export const RENAME_CASES = ['keep', 'lower', 'upper', 'title'] as const;
export type RenameCase = (typeof RENAME_CASES)[number];

const Text = z.string().max(MAX_NAME_BYTES);

/**
 * What happens to each name, in this order: find and replace (every occurrence, plain text, case-sensitive), the case,
 * the numbering pattern (`{n}` or `{n:03}` is the number, `{name}` the name so far; without `{name}` the pattern is the
 * whole new name), then the prefix and the suffix. All of it applies to the name without its extension unless
 * `extension` is true.
 */
export const RenameOps = z.object({
  find: Text.optional(),
  replace: Text.optional(),
  case: z.enum(RENAME_CASES).optional(),
  numbering: z.object({ pattern: z.string().min(1).max(MAX_NAME_BYTES), start: z.number().int().min(0).max(999_999_999) }).strict().optional(),
  prefix: Text.optional(),
  suffix: Text.optional(),
  extension: z.boolean().optional(),
}).strict();
export type RenameOps = z.infer<typeof RenameOps>;

/** Why a new name cannot be used: empty, holds a `/`, longer than 255 bytes, or reserved (see `nameProblem`). */
export const NAME_PROBLEMS = ['empty', 'slash', 'long', 'reserved'] as const;
export type NameProblem = (typeof NAME_PROBLEMS)[number];

/**
 * `invalid`: the new name cannot be used. `batch`: another item of the batch gets the same name, or the name is held by
 * another selected item now. `exists`: an item of the folder outside the batch holds the name.
 */
export const RENAME_CONFLICTS = ['invalid', 'batch', 'exists'] as const;
export type RenameConflict = (typeof RENAME_CONFLICTS)[number];

/** What the member chose for a flagged item: replace the other item (to the trash), take a free `name (n)`, or skip. */
export const RenamePolicy = z.enum(['replace', 'keep-both', 'skip']);
export type RenamePolicy = z.infer<typeof RenamePolicy>;

/** The policies each conflict allows: an invalid name can only be skipped, a selected item is never replaced. */
export const ALLOWED_POLICIES: Record<RenameConflict, readonly RenamePolicy[]> = {
  invalid: ['skip'], batch: ['keep-both', 'skip'], exists: ['replace', 'keep-both', 'skip'],
};

const ItemRef = z.object({ path: z.string().min(1), policy: RenamePolicy.optional() }).strict();

/**
 * Body of `POST /api/v1/renames/preview` and `POST /api/v1/renames`: items of the folder `dir` of `source`, in the order
 * they are numbered, each with the policy chosen for its conflict.
 */
export const RenameRequest = z.object({
  source: z.string().min(1),
  dir: z.string().min(1),
  items: z.array(ItemRef).min(1).max(MAX_RENAME_ITEMS),
  ops: RenameOps,
}).strict();
export type RenameRequest = z.infer<typeof RenameRequest>;

/**
 * One row of the plan. `action`: `rename` (to `to`, with `onCollision` for the move), `unchanged` (the name stays) or
 * `skip`. `conflict` is what was found, `policy` what resolves it; a conflict without a policy blocks the whole batch.
 */
export type RenameRow = { path: string; name: string; to: string; action: 'rename' | 'unchanged' | 'skip';
  conflict: RenameConflict | null; problem: NameProblem | null; policy: RenamePolicy | null; onCollision: 'fail' | 'replace' };
export type RenamePlan = { rows: RenameRow[]; blocked: boolean };

// eslint-disable-next-line no-control-regex -- the C0 and C1 control characters are exactly what is refused
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BIDI = /[؜‎‏‪-‮⁦-⁩]/;
const TEMP_UPLOAD = /^\.[0-9a-f]{16}\.upload$/;

/**
 * Why `name` cannot be a file or folder name, or null. Reserved: `.`, `..`, the app's internal `.files`, the name of a
 * temporary upload file, control or bidi characters, and a trailing space or dot (Windows, WebDAV clients and OneDrive
 * refuse those).
 */
export function nameProblem(name: string): NameProblem | null {
  if (name === '') return 'empty';
  if (name.includes('/')) return 'slash';
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return 'long';
  if (name === '.' || name === '..' || name === '.files' || TEMP_UPLOAD.test(name) || CONTROL.test(name) || BIDI.test(name)
    || /[ .]$/.test(name)) return 'reserved';
  return null;
}

/** A file's name as stem and extension (`.jpg`); a folder, a dot file without another dot, or no dot: no extension. */
export function splitName(name: string, type: 'file' | 'directory'): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (type === 'directory' || dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s_-])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toUpperCase());

// `{n}`, `{n:0W}` (W from 1 to 9 digits, zero-padded) and `{name}`; any other brace stays as typed.
function fillPattern(pattern: string, n: number, name: string): string {
  return pattern.replace(/\{n(?::0([1-9]))?\}|\{name\}/g, (m, width: string | undefined) =>
    m === '{name}' ? name : String(n).padStart(width ? Number(width) : 0, '0'));
}

/** The new name of one item at position `index` of the batch (numbered from `ops.numbering.start`). */
export function renameOne(name: string, type: 'file' | 'directory', ops: RenameOps, index: number): string {
  const { stem, ext } = ops.extension ? { stem: name, ext: '' } : splitName(name, type);
  let s = stem;
  if (ops.find) s = s.split(ops.find).join(ops.replace ?? '');
  if (ops.case === 'lower') s = s.toLowerCase();
  else if (ops.case === 'upper') s = s.toUpperCase();
  else if (ops.case === 'title') s = titleCase(s);
  if (ops.numbering) s = fillPattern(ops.numbering.pattern, ops.numbering.start + index, s);
  s = (ops.prefix ?? '') + s + (ops.suffix ?? '');
  return (s + ext).normalize('NFC');
}

/** Free "keep both" names tried, as the backends do. */
const KEEP_BOTH_TRIES = 1000;

/** Names compared the way the strictest source does: NFC, ignoring case (Dropbox, OneDrive and SharePoint). */
export const nameKey = (name: string) => name.normalize('NFC').toLowerCase();

/** `name (n).ext`, the numbering every "keep both" in the app uses. */
export function numberedName(name: string, type: 'file' | 'directory', n: number): string {
  const { stem, ext } = splitName(name, type);
  return `${stem} (${n})${ext}`;
}

/**
 * The plan for renaming `items` (in batch order) in a folder holding `existing` names (the items' own names included).
 * Pure: the server's preview and its job both call it with the same inputs.
 */
export function planRenames(items: readonly { path: string; name: string; type: 'file' | 'directory'; policy?: RenamePolicy }[],
  existing: readonly string[], ops: RenameOps): RenamePlan {
  const rows: RenameRow[] = items.map((it, i) => {
    const to = renameOne(it.name, it.type, ops, i);
    const problem = nameProblem(to);
    return { path: it.path, name: it.name, to, problem, conflict: problem ? 'invalid' : null, policy: null,
      action: to === it.name ? 'unchanged' : 'rename', onCollision: 'fail' };
  });
  const selected = new Map(items.map((it, i) => [nameKey(it.name), i]));
  const outside = new Set(existing.map(nameKey).filter((k) => !selected.has(k)));
  // Every name a free "keep both" name must avoid: the folder's, the selected items' and every new name.
  const taken = new Set([...existing.map(nameKey), ...rows.map((r) => nameKey(r.to))]);
  const firstWith = new Map<string, number>();
  rows.forEach((r, i) => {
    if (r.conflict || r.action === 'unchanged') return;
    const k = nameKey(r.to);
    const holder = selected.get(k);
    if (firstWith.has(k) || (holder !== undefined && holder !== i)) r.conflict = 'batch';
    else if (outside.has(k)) r.conflict = 'exists';
    if (!firstWith.has(k)) firstWith.set(k, i);
  });
  rows.forEach((r, i) => {
    if (!r.conflict) return;
    const chosen = items[i]!.policy;
    if (!chosen || !ALLOWED_POLICIES[r.conflict].includes(chosen)) return;
    r.policy = chosen;
    if (chosen === 'skip') { r.action = 'skip'; return; }
    if (chosen === 'replace') { r.onCollision = 'replace'; return; }
    for (let n = 1; n < KEEP_BOTH_TRIES; n++) {
      const free = numberedName(r.to, items[i]!.type, n);
      if (taken.has(nameKey(free)) || nameProblem(free)) continue;
      taken.add(nameKey(free));
      r.to = free;
      return;
    }
    r.policy = null; // no free name (a name at the length limit): the conflict stays
  });
  return { rows, blocked: rows.some((r) => r.conflict !== null && r.policy === null) };
}
