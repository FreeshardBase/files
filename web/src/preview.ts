// What the preview overlay shows for a file (#142). Decided from the listed MIME type, which the server derives from
// the extension; the server's inline allowlist (routes/sources.ts) is the guard, this only picks the viewer.
import type { Entry, ThumbSize } from '@files/shared';
import { rawRequest } from './api/client.ts';
import { sourceApi } from './api/paths.ts';

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'markdown' | 'text' | 'none';

// Raster formats browsers decode. Not SVG (it can carry script) and not HEIC (no browser decodes it).
const IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const TEXT = new Set(['application/json', 'application/xml']);

export function previewKind(mime: string | undefined): PreviewKind {
  const base = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  if (IMAGES.has(base)) return 'image';
  if (base.startsWith('video/')) return 'video';
  if (base.startsWith('audio/')) return 'audio';
  if (base === 'application/pdf') return 'pdf';
  if (base === 'text/markdown') return 'markdown';
  // Shown as text in a text node, so markup in it (HTML, XML) is never parsed.
  if (base.startsWith('text/') || TEXT.has(base)) return 'text';
  return 'none';
}

// Types the server makes a thumbnail of (server/src/storage/thumbnails.ts); everything else keeps its line icon.
const THUMBNAILED = new Set([...IMAGES, 'video/mp4', 'video/quicktime', 'video/webm', 'video/ogg', 'application/pdf']);

export const hasThumbnail = (e: Entry): boolean =>
  e.type === 'file' && THUMBNAILED.has((e.mime ?? '').split(';')[0]!.trim().toLowerCase());

/** The thumbnail route; `v` (the modified time) gives a changed file a new URL, so the browser may cache each one. */
export const thumbnailHref = (source: string, e: Entry, size: ThumbSize): string =>
  `${sourceApi(source)}/thumbnail?path=${encodeURIComponent(e.path)}&size=${size}&v=${encodeURIComponent(e.modified)}`;

/** URL the viewers load: the content route without `download=1`, inline for the allowlist. */
export const contentHref = (source: string, path: string): string => `${sourceApi(source)}/content?path=${encodeURIComponent(path)}`;

/** Bytes of a text file the preview fetches; a longer file shows its start and offers the download. */
export const TEXT_CAP = 512 * 1024;

/** The first `TEXT_CAP` bytes as text, fetched with a Range request, so a large file is never loaded whole. */
export async function fetchText(source: string, path: string, size: number): Promise<{ text: string; truncated: boolean }> {
  const truncated = size > TEXT_CAP;
  // An empty file has no satisfiable range, so the range is only sent when it cuts something off.
  const res = await rawRequest('GET', contentHref(source, path), truncated ? { range: `bytes=0-${TEXT_CAP - 1}` } : {});
  // A cut in the middle of a UTF-8 sequence becomes one replacement character at the end.
  return { text: new TextDecoder().decode(await res.arrayBuffer()), truncated };
}
