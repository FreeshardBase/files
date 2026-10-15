const MAP: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', mp4: 'video/mp4',
  webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
  json: 'application/json', zip: 'application/zip', html: 'text/html', svg: 'image/svg+xml',
};
export function lookupMime(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return MAP[ext] ?? 'application/octet-stream';
}
