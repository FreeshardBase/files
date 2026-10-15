import { AppError } from '../errors.ts';

// The `If` header (RFC 4918 §10.4): lists of conditions, each a state token (`<opaquelocktoken:…>`, `<DAV:no-lock>`) or
// an entity tag (`["…"]`), optionally negated with `Not`, either for the request URL (no tag) or for a tagged resource.

export type Condition = { not: boolean } & ({ token: string } | { etag: string });
/** `tag`: the raw resource URL of a tagged list; undefined for the request URL. */
export type IfList = { tag?: string; conditions: Condition[] };

export function parseIf(header: string): IfList[] {
  const lists: IfList[] = [];
  let i = 0; let tag: string | undefined; let sawTag = false; let sawUntagged = false;
  const fail = (): never => { throw new AppError('VALIDATION'); };
  const until = (end: string) => {
    const j = header.indexOf(end, i + 1);
    if (j < 0) fail();
    const v = header.slice(i + 1, j);
    i = j + 1;
    return v;
  };
  const skip = () => { while (i < header.length && /\s/.test(header[i]!)) i++; };
  for (skip(); i < header.length; skip()) {
    if (header[i] === '<') { tag = until('>'); sawTag = true; continue; }
    if (header[i] !== '(') fail();
    i++;
    if (!tag) sawUntagged = true;
    const conditions: Condition[] = [];
    for (skip(); header[i] !== ')'; skip()) {
      if (i >= header.length) fail();
      let not = false;
      if (header.startsWith('Not', i) && /[\s<[]/.test(header[i + 3] ?? '')) { not = true; i += 3; skip(); }
      if (header[i] === '<') conditions.push({ not, token: until('>') });
      else if (header[i] === '[') conditions.push({ not, etag: until(']') });
      else fail();
    }
    i++;
    if (conditions.length === 0) fail();
    lists.push({ ...(tag !== undefined ? { tag } : {}), conditions });
  }
  // A header is either all untagged lists or all tagged ones.
  if (lists.length === 0 || (sawTag && sawUntagged)) fail();
  return lists;
}

/** Every state token named anywhere in the header: the lock tokens the client submits. */
export const submittedTokens = (lists: readonly IfList[]): Set<string> =>
  new Set(lists.flatMap((l) => l.conditions.flatMap((c) => 'token' in c ? [c.token] : [])));

/** Weak tags compare by their opaque part, as the header carries what the client saw. */
export const sameEtag = (a: string, b: string): boolean => a.replace(/^W\//, '') === b.replace(/^W\//, '');
