const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
export function formatSize(bytes: number, locale: string): string {
  let i = 0; let v = bytes;
  while (v >= 1000 && i < UNITS.length - 1) { v /= 1000; i++; }
  return new Intl.NumberFormat(locale, { style: 'unit', unit: UNITS[i], unitDisplay: 'short', maximumFractionDigits: i === 0 ? 0 : 1 }).format(v);
}
export function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}
// A name cut in the middle (#237): the head takes the ellipsis, the tail stays whole, so a tile keeps the extension and
// the end of the name, where names in one folder tend to differ ("Urlaub 01.png", "Urlaub 02.png"). The tail is the
// extension (up to 8 characters after the last dot, never a leading dot) plus the 4 characters before it.
export function nameParts(name: string): [head: string, tail: string] {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 9 ? name.length - dot : 0;
  const cut = Math.max(0, name.length - ext - 4);
  return [name.slice(0, cut), name.slice(cut)];
}
export const intlLocale =(l: string) => (l.startsWith('de') ? 'de-DE' : 'en-GB');
