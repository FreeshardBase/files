import type { Entry, Sort } from '@files/shared';

// The folder sort (#226). Folders always come first; within each group the member's key and direction apply. Names
// compare naturally and locale-aware ("file-2" before "file-10", "é" next to "e"), ignoring case and punctuation, so a
// leading space or dot does not put a name first. Ties fall back to the name, then to the code points, so the order is
// total and stable across reloads.

const collators = new Map<string, Intl.Collator>();
function collator(locale: string): Intl.Collator {
  let c = collators.get(locale);
  if (!c) {
    c = new Intl.Collator(locale, { numeric: true, sensitivity: 'base', ignorePunctuation: true });
    collators.set(locale, c);
  }
  return c;
}

/** The entries in the member's sort; `locale` is an Intl locale (`intlLocale`). The input is left as it is. */
export function sortEntries(entries: readonly Entry[], sort: Sort, locale: string): Entry[] {
  const c = collator(locale);
  const byName = (a: Entry, b: Entry) => c.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  // An item without a modification time (some providers) counts as the oldest.
  const time = (e: Entry) => (e.modified ? Date.parse(e.modified) : -Infinity);
  const byKey = sort.key === 'size' ? (a: Entry, b: Entry) => a.size - b.size
    : sort.key === 'modified' ? (a: Entry, b: Entry) => (time(a) === time(b) ? 0 : time(a) < time(b) ? -1 : 1)
      : byName;
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return sign * byKey(a, b) || byName(a, b);
  });
}
