export function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined | 'unsatisfiable' {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, s, e] = m;
  if (s === '' && e === '') return undefined;
  let start: number; let end: number;
  if (s === '') { const n = Number(e); if (n === 0) return 'unsatisfiable'; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(s); end = e === '' ? size - 1 : Math.min(Number(e), size - 1); }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
