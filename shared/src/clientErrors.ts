import { z } from 'zod';

/**
 * Browser errors reported to the server (#298): an uncaught error, an unhandled rejection or a Vue render error. A report
 * carries the route's name, never its path or query, and its text is redacted on both sides: the browser before it
 * sends, the server again before it logs, since a report is whatever a browser chose to send.
 */

/** Bytes kept of a stack (UTF-8). */
export const MAX_STACK_BYTES = 4096;
/** Bytes kept of a message. */
export const MAX_MESSAGE_BYTES = 1024;
const MAX_FIELD_BYTES = 256;

/** Lenient on length: an overlong field is trimmed by `cleanReport`, not refused. */
export const ClientErrorReport = z.object({
  message: z.string().max(16_384),
  stack: z.string().max(65_536).optional(),
  route: z.string().max(1024),
  build: z.string().max(1024),
  userAgent: z.string().max(1024),
});
export type ClientErrorReport = z.infer<typeof ClientErrorReport>;

/** Cuts `s` to at most `max` UTF-8 bytes, never inside a character. */
export function trimBytes(s: string, max: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= max) return s;
  return new TextDecoder().decode(bytes.subarray(0, max)).replace(/�$/, '');
}

// A URL or a path that starts with "/" (not inside a word, a URL or a "line:column"). The bundle's own files under
// /assets/ (and /sw.js) stay, so a stack still points into the build; any other path, every query and fragment goes.
const URL_OR_PATH = /https?:\/\/[^\s'"()<>]+|(?<![\w.:/%-])\/[^\s'"()<>]+/g;
const BUNDLE_FILE = /^\/(assets\/[\w.-]+|sw\.js)(:\d+)*$/;
// A token-like run: 20 or more URL-safe characters with at least one digit and one letter (link tokens, ids, bearer
// tokens). Identifiers in a stack rarely mix in digits.
const TOKEN = /(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{20,}(?![\w-])/g;

function redactUrl(match: string): string {
  if (!match.startsWith('/')) {
    let url: URL;
    try { url = new URL(match); }
    catch { return '<url>'; } // handled: what does not parse as a URL is replaced whole
    return url.origin + (BUNDLE_FILE.test(url.pathname) ? url.pathname : '/<path>');
  }
  return '<path>';
}

/** Replaces paths (except the bundle's files), query strings and token-like strings. */
export const redact = (text: string): string => text.replace(URL_OR_PATH, redactUrl).replace(TOKEN, '<token>');

/** A report as it may be sent and logged: every field redacted and trimmed. */
export function cleanReport(r: ClientErrorReport): ClientErrorReport {
  const field = (s: string) => trimBytes(redact(s), MAX_FIELD_BYTES);
  return { message: trimBytes(redact(r.message), MAX_MESSAGE_BYTES), ...(r.stack !== undefined ? { stack: trimBytes(redact(r.stack), MAX_STACK_BYTES) } : {}),
    route: field(r.route), build: field(r.build), userAgent: trimBytes(r.userAgent, MAX_FIELD_BYTES) };
}
