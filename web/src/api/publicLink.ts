import { ERROR_CODES, type Entry, type ErrorCode, type PublicLinkInfo } from '@files/shared';
import { ApiFailure } from './client.ts';

// The visitor's side of a public link (#147). No session, no CSRF token and no login redirect: a visitor has no
// account, and every answer, 403 included, is about the link.
const base = (token: string) => `/s/${encodeURIComponent(token)}`;

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try { res = await fetch(url, { ...init, credentials: 'same-origin' }); }
  catch { throw new ApiFailure('NETWORK'); } // handled: any fetch rejection is a network failure
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { code?: ErrorCode }; // handled: a non-JSON error body becomes INTERNAL
    throw new ApiFailure(body.code ?? 'INTERNAL');
  }
  if (res.status === 204) return undefined as T;
  return await res.json() as T;
}

export const linkInfo = (token: string) => call<PublicLinkInfo>(`${base(token)}/info`);

export const unlockLink = (token: string, password: string) => call<void>(`${base(token)}/unlock`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });

/** Every entry of a folder in the link, all pages. */
export async function linkList(token: string, path: string): Promise<Entry[]> {
  const out: Entry[] = [];
  let cursor: string | undefined;
  do {
    const q = new URLSearchParams({ path, ...(cursor ? { cursor } : {}) });
    const page = await call<{ entries: Entry[]; next?: string }>(`${base(token)}/list?${q}`);
    out.push(...page.entries);
    cursor = page.next;
  } while (cursor);
  return out;
}

/** A download (or, with `inline`, a preview in a new tab); both count against the link's limit. */
export const linkContentHref = (token: string, path: string, inline = false) =>
  `${base(token)}/content?${new URLSearchParams({ path, ...(inline ? { inline: '1' } : {}) })}`;

/** The `?error=` the server sends a refused download back with, if it is a code we know. */
export const pageError = (value: unknown): ErrorCode | null =>
  typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value) ? value as ErrorCode : null;
