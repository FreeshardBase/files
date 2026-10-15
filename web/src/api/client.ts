import type { ErrorCode } from '@files/shared';

export class ApiFailure extends Error {
  constructor(public code: ErrorCode | 'NETWORK', public params?: Record<string, string | number>) { super(code); }
}

let csrf = '';
export const setCsrf = (t: string) => { csrf = t; };

/** The server sends a failed login back with `?loginError=1`; the shell then shows the error instead of looping into login. */
export const loginFailed = (): boolean => new URLSearchParams(location.search).get('loginError') === '1';

function redirectToLogin() {
  if (loginFailed()) return;
  location.href = '/auth/login?returnTo=' + encodeURIComponent(location.pathname + location.search);
}

async function request<T>(method: string, path: string, init: { query?: Record<string, string>; body?: BodyInit; json?: unknown } = {}): Promise<T> {  const url = init.query ? `${path}?${new URLSearchParams(init.query)}` : path;
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, { method, headers, credentials: 'same-origin',
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  } catch {
    throw new ApiFailure('NETWORK'); // handled: any fetch rejection is a network failure
  }
  if (res.status === 401) { redirectToLogin(); throw new ApiFailure('UNAUTHENTICATED'); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as ErrorBody)) as ErrorBody; // handled: non-JSON error body becomes INTERNAL
    throw new ApiFailure(body.code ?? 'INTERNAL', body.params);
  }
  if (res.status === 204) return undefined as T;
  try { return await res.json() as T; }
  catch { throw new ApiFailure('INTERNAL'); } // handled: a 2xx whose body is not JSON is a broken response
}

type ErrorBody = { code?: ErrorCode; params?: Record<string, string | number> };
function parseBody(text: string): ErrorBody | null {
  try { return JSON.parse(text) as ErrorBody; }
  catch { return null; } // handled: callers report a non-JSON body as INTERNAL
}

// A body-less answer (HEAD) still has a status; these are the ones a caller tells apart.
const codeOfStatus = (status: number): ErrorCode => (status === 404 ? 'NOT_FOUND' : status === 423 ? 'UPLOAD_LOCKED' : 'INTERNAL');

/**
 * A request whose answer lives in headers (tus). The CSRF token goes on every mutating method; a network failure is
 * NETWORK, 401 goes to login, and any other non-2xx status is an ApiFailure from the error body (or the status).
 */
export async function rawRequest(method: string, url: string, headers: Record<string, string>): Promise<Response> {
  const h = { ...headers };
  if (method !== 'GET' && method !== 'HEAD') h['x-csrf-token'] = csrf;
  let res: Response;
  try { res = await fetch(url, { method, headers: h, credentials: 'same-origin' }); }
  catch { throw new ApiFailure('NETWORK'); } // handled: any fetch rejection is a network failure
  if (res.status === 401) { redirectToLogin(); throw new ApiFailure('UNAUTHENTICATED'); }
  if (!res.ok) {
    const body = method === 'HEAD' ? null : parseBody(await res.text());
    throw new ApiFailure(body?.code ?? codeOfStatus(res.status), body?.params);
  }
  return res;
}

export type XhrResult = { status: number; header(name: string): string | null; text: string };
/**
 * An XMLHttpRequest, for upload progress. Resolves with any 2xx; a non-2xx is an ApiFailure from the error body, a
 * network failure, abort or timeout is NETWORK. `abort` stops it (the promise then rejects with NETWORK).
 */
export function sendXhr(method: string, url: string, headers: Record<string, string>, body: Blob,
  onProgress?: (loaded: number) => void): { abort(): void; done: Promise<XhrResult> } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<XhrResult>((resolve, reject) => {
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.upload.onprogress = (e) => { onProgress?.(e.loaded); };
    xhr.onerror = () => reject(new ApiFailure('NETWORK'));
    xhr.onabort = () => reject(new ApiFailure('NETWORK'));
    xhr.ontimeout = () => reject(new ApiFailure('NETWORK'));
    xhr.onload = () => {
      if (xhr.status === 401) { redirectToLogin(); return reject(new ApiFailure('UNAUTHENTICATED')); }
      if (xhr.status >= 200 && xhr.status < 300) {
        return resolve({ status: xhr.status, header: (n) => xhr.getResponseHeader(n), text: xhr.responseText });
      }
      const parsed = parseBody(xhr.responseText);
      reject(new ApiFailure(parsed?.code ?? codeOfStatus(xhr.status), parsed?.params));
    };
    xhr.send(body);
  });
  return { abort: () => xhr.abort(), done };
}

export const api = {
  get: <T>(path: string, query?: Record<string, string>) => request<T>('GET', path, query ? { query } : {}),
  post: <T>(path: string, json: unknown) => request<T>('POST', path, { json }),
  patch: <T>(path: string, json: unknown) => request<T>('PATCH', path, { json }),
  delete: (path: string) => request<void>('DELETE', path),
};
