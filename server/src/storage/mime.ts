// By extension only, never by sniffing the bytes. The content route decides inline vs. attachment from this
// (allowlist in routes/sources.ts), the SPA picks the preview from the listed `mime`.
const MAP: Record<string, string> = {
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', heic: 'image/heic', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  flac: 'audio/flac', wav: 'audio/wav', json: 'application/json', zip: 'application/zip',
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml', xml: 'application/xml', svg: 'image/svg+xml',
};
export function lookupMime(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return MAP[ext] ?? 'application/octet-stream';
}
