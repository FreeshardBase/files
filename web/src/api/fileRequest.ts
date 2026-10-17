import type { ErrorCode, FileRequestInfo } from '@files/shared';
import { ApiFailure, type XhrResult } from './client.ts';

// The visitor's side of a file request (#217). No session, no CSRF token and no login redirect, like a public link's
// page: every answer is about the request. Uploads are tus against `/r/<token>/uploads`, in chunks, retried from the
// server's offset after a network failure.
const base = (token: string) => `/r/${encodeURIComponent(token)}`;
const TUS = { 'tus-resumable': '1.0.0' };
const CHUNK_BYTES = 8 * 1024 * 1024;
const RETRY_DELAYS_MS = [300, 1000, 3000];

type ErrorBody = { code?: ErrorCode };
const codeOf = (text: string, status: number): ErrorCode => {
  try { return (JSON.parse(text) as ErrorBody).code ?? 'INTERNAL'; }
  catch { return status === 404 ? 'NOT_FOUND' : 'INTERNAL'; } // handled: a body-less or non-JSON answer is named by its status
};

async function call(url: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try { res = await fetch(url, { ...init, credentials: 'same-origin' }); }
  catch { throw new ApiFailure('NETWORK'); } // handled: any fetch rejection is a network failure
  if (!res.ok) throw new ApiFailure(codeOf(init.method === 'HEAD' ? '' : await res.text(), res.status));
  return res;
}

export const requestInfo = async (token: string): Promise<FileRequestInfo> => await (await call(`${base(token)}/info`)).json() as FileRequestInfo;

export const unlockRequest = async (token: string, password: string): Promise<void> => {
  await call(`${base(token)}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
};

const b64 = (s: string) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(''));
const retryable = (e: unknown) => e instanceof ApiFailure
  && (e.code === 'NETWORK' || e.code === 'UPLOAD_LOCKED' || e.code === 'OFFSET_MISMATCH' || e.code === 'INTERNAL' || e.code === 'LINK_UNAVAILABLE');

function patch(url: string, offset: number, chunk: Blob, onProgress: (loaded: number) => void): Promise<XhrResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PATCH', url);
    for (const [k, v] of Object.entries({ ...TUS, 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' })) {
      xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => { onProgress(e.loaded); };
    xhr.onerror = () => reject(new ApiFailure('NETWORK'));
    xhr.onabort = () => reject(new ApiFailure('NETWORK'));
    xhr.ontimeout = () => reject(new ApiFailure('NETWORK'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve({ status: xhr.status, header: (n) => xhr.getResponseHeader(n), text: xhr.responseText });
      else reject(new ApiFailure(codeOf(xhr.responseText, xhr.status)));
    };
    xhr.send(chunk);
  });
}

/**
 * Sends one file to the request: creation (with the name and, if given, the uploader's name), then PATCHes from the
 * server's offset. A network failure is retried a few times from what the server has; anything else rejects.
 */
export async function sendFile(token: string, file: File, uploader: string, onProgress: (sent: number) => void): Promise<void> {
  const meta = [`name ${b64(file.name)}`, ...(uploader.trim() ? [`uploader ${b64(uploader.trim())}`] : [])].join(',');
  const created = await call(`${base(token)}/uploads`, { method: 'POST',
    headers: { ...TUS, 'upload-length': String(file.size), 'upload-metadata': meta } });
  const url = created.headers.get('location');
  if (!url) throw new ApiFailure('INTERNAL');
  let offset = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      // At least one PATCH: an empty file is placed by its (empty) last PATCH like any other.
      do {
        const chunk = file.slice(offset, Math.min(offset + CHUNK_BYTES, file.size));
        const r = await patch(url, offset, chunk, (loaded) => onProgress(offset + loaded));
        const next = Number(r.header('upload-offset'));
        if (!Number.isSafeInteger(next) || (chunk.size > 0 && next <= offset)) throw new ApiFailure('INTERNAL');
        offset = next;
        onProgress(offset);
      } while (offset < file.size);
      return;
    } catch (e) {
      if (!retryable(e) || attempt >= RETRY_DELAYS_MS.length) throw e;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
      const head = await call(url, { method: 'HEAD', headers: TUS });
      offset = Number(head.headers.get('upload-offset'));
      if (!Number.isSafeInteger(offset)) throw new ApiFailure('INTERNAL');
    }
  }
}
