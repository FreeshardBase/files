import { AppError } from '../errors.ts';
import { normalizeUserPath } from '../storage/resolveInRoot.ts';

// WebDAV addresses (#157): `/dav/<home path>`, every segment percent-encoded. The request path is decoded here segment
// by segment, never through URL resolution: `new URL` would quietly resolve `..` and `%2e%2e`, so a traversal would turn
// into a different path instead of being refused. The decoded path then goes through `normalizeUserPath` (no `..`, no
// control characters) and the backend's `resolveInRoot` like every other user path.

export const DAV_PREFIX = '/dav';

/** Thrown for a Destination or If tag outside the WebDAV tree: another server's resource, 502 (RFC 4918 §9.8.5). */
export class ForeignUrl extends Error {}

function fromPathname(pathname: string): string {
  if (pathname !== DAV_PREFIX && !pathname.startsWith(`${DAV_PREFIX}/`)) throw new ForeignUrl(pathname);
  const segments = pathname.slice(DAV_PREFIX.length).split('/').filter((s) => s.length > 0).map((s) => {
    let d: string;
    try { d = decodeURIComponent(s); }
    catch (e) { throw new AppError('PATH_INVALID', undefined, { cause: e }); } // a malformed escape is not a name
    // An encoded slash would join two segments behind the check below; a name never holds one.
    if (d.includes('/') || d.length === 0) throw new AppError('PATH_INVALID');
    return d;
  });
  return normalizeUserPath('/' + segments.join('/'));
}

/**
 * The home path of a request URL (path and query as received). A raw `#` never belongs in a request: cutting the URL
 * there would turn `DELETE /dav/a/#b` into a delete of the folder `a`, so it is refused.
 */
export function requestPath(url: string): string {
  const pathname = url.split('?')[0]!;
  if (pathname.includes('#')) throw new AppError('PATH_INVALID');
  return fromPathname(pathname);
}

/**
 * The home path of an absolute URL or absolute path in a header (Destination, an If tag). The scheme and host are not
 * compared: behind the shard proxy the client's host is not ours to know; the path decides.
 */
export function headerPath(value: string): string {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/.exec(value);
  const pathname = m ? (m[1] ?? '/') : value.split(/[?#]/)[0]!;
  if (!pathname.startsWith('/')) throw new AppError('VALIDATION');
  return fromPathname(pathname);
}

/** The encoded href of a home path; collections end with a slash. */
export function hrefOf(path: string, collection: boolean): string {
  const segs = path.split('/').filter(Boolean).map(encodeURIComponent);
  const p = `${DAV_PREFIX}/${segs.join('/')}`;
  return collection && segs.length > 0 ? `${p}/` : p;
}

export const parentOf = (path: string): string => path === '/' ? '/' : (path.slice(0, path.lastIndexOf('/')) || '/');
export const isUnder = (path: string, root: string): boolean => root === '/' ? true : path === root || path.startsWith(root + '/');
