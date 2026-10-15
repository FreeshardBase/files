import type { FastifyReply, FastifyRequest } from 'fastify';
import { RangeNotSatisfiable, type StorageBackend } from '../storage/backend.ts';
import { parseRange } from './range.ts';

// Allowlist, not denylist: anything not known to be inert in a browser is downloaded, never rendered.
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf', 'text/plain']);
export const inlineSafe = (mime: string): boolean => {
  const base = mime.split(';')[0]!.trim().toLowerCase();
  return INLINE.has(base) || base.startsWith('video/') || base.startsWith('audio/');
};
export const CONTENT_CSP = "sandbox; default-src 'none'";

export const disposition = (kind: 'inline' | 'attachment', name: string) => {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  // RFC 5987 attr-char excludes ' ( ) * ! which encodeURIComponent leaves alone.
  const encoded = encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

/** One backend read with the request's Range resolved against the size of the file actually opened. */
export async function readRanged(b: StorageBackend, path: string, req: FastifyRequest, reply: FastifyReply) {
  return b.read(path, (size) => {
    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') throw new RangeNotSatisfiable(size);
    return range;
  }).catch((e: unknown) => {
    if (e instanceof RangeNotSatisfiable) reply.header('content-range', `bytes */${e.size}`);
    throw e;
  });
}

/**
 * Sends what `readRanged` opened. Inline only when asked and the type is on the allowlist; always the sandbox CSP and
 * `nosniff`, so HTML, SVG and XML never run in the app's origin.
 */
export function sendContent(reply: FastifyReply, r: Awaited<ReturnType<typeof readRanged>>, wantInline: boolean, cache: string) {
  const mime = r.entry.mime ?? 'application/octet-stream';
  const kind = wantInline && inlineSafe(mime) ? 'inline' : 'attachment';
  reply.header('content-type', mime).header('etag', r.etag).header('accept-ranges', 'bytes')
    .header('content-disposition', disposition(kind, r.entry.name)).header('cache-control', cache)
    .header('content-security-policy', CONTENT_CSP).header('x-content-type-options', 'nosniff');
  if (r.range) {
    reply.status(206).header('content-range', `bytes ${r.range.start}-${r.range.end}/${r.entry.size}`)
      .header('content-length', r.range.end - r.range.start + 1);
  } else {
    reply.header('content-length', r.entry.size);
  }
  return reply.send(r.stream);
}
