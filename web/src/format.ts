const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
export function formatSize(bytes: number, locale: string): string {
  let i = 0; let v = bytes;
  while (v >= 1000 && i < UNITS.length - 1) { v /= 1000; i++; }
  return new Intl.NumberFormat(locale, { style: 'unit', unit: UNITS[i], unitDisplay: 'short', maximumFractionDigits: i === 0 ? 0 : 1 }).format(v);
}
export function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}
export const intlLocale = (l: string) => (l.startsWith('de') ? 'de-DE' : 'en-GB');
