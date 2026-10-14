import type { ErrorCode } from '@files/shared';

export class ApiFailure extends Error {
  constructor(public code: ErrorCode | 'NETWORK', public params?: Record<string, string | number>) { super(code); }
}

let csrf = '';
export const setCsrf = (t: string) => { csrf = t; };

function redirectToLogin() {
  location.href = '/auth/login?returnTo=' + encodeURIComponent(location.pathname + location.search);
}

async function request<T>(method: string, path: string, init: { query?: Record<string, string>; body?: BodyInit; json?: unknown } = {}): Promise<T> {
  const url = init.query ? `${path}?${new URLSearchParams(init.query)}` : path;
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

export const api = {
  get: <T>(path: string, query?: Record<string, string>) => request<T>('GET', path, query ? { query } : {}),
  post: <T>(path: string, json: unknown) => request<T>('POST', path, { json }),
  put<T>(path: string, query: Record<string, string>, body: Blob, onProgress?: (fraction: number) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${path}?${new URLSearchParams(query)}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.setRequestHeader('x-csrf-token', csrf);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
      xhr.onerror = () => reject(new ApiFailure('NETWORK'));
      xhr.onabort = () => reject(new ApiFailure('NETWORK'));
      xhr.ontimeout = () => reject(new ApiFailure('NETWORK'));
      xhr.onload = () => {
        if (xhr.status === 401) { redirectToLogin(); return reject(new ApiFailure('UNAUTHENTICATED')); }
        const parsed = parseBody(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          if (parsed === null) reject(new ApiFailure('INTERNAL'));
          else resolve(parsed as T);
        } else reject(new ApiFailure(parsed?.code ?? 'INTERNAL', parsed?.params));
      };
      xhr.send(body);
    });
  },
};
