// A tus 1.0 client for `/api/v1/uploads` (#140): creation, HEAD to learn the offset, PATCH in chunks, termination.
// An upload is remembered in localStorage by target, size and modification time, so picking the same file again
// after a reload continues where the server stopped instead of starting over.
import type { CollisionPolicy, Entry } from '@files/shared';
import { api, ApiFailure, rawRequest, sendXhr } from './client.ts';

export const UPLOADS = '/api/v1/uploads';
/** Bytes per PATCH: bounds what a dropped connection or a buffering proxy can lose. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
/** Waits before the automatic retries after a network failure; then the item fails and the user retries. */
export const RETRY_DELAYS_MS = [300, 1000];
const TUS = { 'tus-resumable': '1.0.0' };

export type Target = { source: string; path: string };
export type RunResult = 'done' | 'paused';

const b64 = (s: string) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(''));
// A conflicting offset, a busy upload or a server hiccup heals with HEAD + PATCH; anything else is final.
const retryable = (e: unknown) => e instanceof ApiFailure
  && (e.code === 'NETWORK' || e.code === 'UPLOAD_LOCKED' || e.code === 'OFFSET_MISMATCH' || e.code === 'INTERNAL');

// localStorage can be unavailable (storage disabled); resuming after a reload is then not offered, nothing else changes.
const storage = {
  get(key: string): string | null {
    try { return localStorage.getItem(key); }
    catch { return null; } // handled: no storage means no upload to resume
  },
  set(key: string, value: string): void {
    try { localStorage.setItem(key, value); }
    catch { /* handled: without storage the upload simply cannot be resumed after a reload */ }
  },
  remove(key: string): void {
    try { localStorage.removeItem(key); }
    catch { /* handled: nothing was stored */ }
  },
};

export class ResumableUpload {
  private xhr: { abort(): void } | null = null;
  private paused = false;
  private wake: (() => void) | null = null;
  private readonly key: string;

  constructor(readonly file: File, readonly target: Target, private onProgress: (sent: number) => void) {
    this.key = `files.upload:${target.source}:${target.path}:${file.size}:${file.lastModified}`;
  }

  /**
   * Sends whatever the server does not have yet and places the file with `policy`. Resolves 'paused' after `pause()`.
   * A taken name rejects with FILE_EXISTS (at creation, or at the end if it was taken meanwhile); calling `run` again
   * with another policy then places the bytes already sent instead of sending them again.
   */
  async run(policy: CollisionPolicy): Promise<RunResult> {
    this.paused = false;
    for (let attempt = 0; ; attempt++) {
      try { return await this.attempt(policy); }
      catch (e) {
        if (this.paused) return 'paused';
        if (!retryable(e) || attempt >= RETRY_DELAYS_MS.length) throw e;
        await this.sleep(RETRY_DELAYS_MS[attempt]!);
        if (this.paused) return 'paused';
      }
    }
  }

  /** Stops sending; the server keeps what it has, so `run` continues from there. */
  pause(): void {
    this.paused = true;
    this.xhr?.abort();
    this.wake?.();
  }

  /** Stops and drops the upload on the server (tus termination). */
  async discard(): Promise<void> {
    this.pause();
    const url = storage.get(this.key);
    if (!url) return;
    await rawRequest('DELETE', url, TUS).catch((e: unknown) => {
      if (!(e instanceof ApiFailure && e.code === 'NOT_FOUND')) throw e; // handled: already gone (completed or expired)
    });
    storage.remove(this.key);
  }

  private async attempt(policy: CollisionPolicy): Promise<RunResult> {
    const size = this.file.size;
    let url = storage.get(this.key);
    let offset = 0;
    if (url) {
      const known = await this.head(url);
      if (known === null) { storage.remove(this.key); url = null; } else offset = known;
    }
    if (!url) {
      url = await this.create(policy);
      storage.set(this.key, url);
    } else if (offset === size) {
      // Everything is on the server; only the placement is left (the name was taken at the end).
      await api.post<Entry>(`${url}/finish`, { onCollision: policy });
      storage.remove(this.key);
      return 'done';
    }
    this.onProgress(offset);
    // At least one PATCH: an empty file is placed by its (empty) last PATCH like any other.
    do {
      if (this.paused) return 'paused';
      offset = await this.patch(url, offset, this.file.slice(offset, Math.min(offset + CHUNK_BYTES, size)));
      this.onProgress(offset);
    } while (offset < size);
    storage.remove(this.key);
    return 'done';
  }

  private async head(url: string): Promise<number | null> {
    try {
      const res = await rawRequest('HEAD', url, TUS);
      const offset = Number(res.headers.get('upload-offset'));
      if (!Number.isSafeInteger(offset)) throw new ApiFailure('INTERNAL');
      return offset;
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'NOT_FOUND') return null; // handled: expired or finished, start a new upload
      throw e;
    }
  }

  private async create(policy: CollisionPolicy): Promise<string> {
    const { source, path } = this.target;
    const res = await rawRequest('POST', UPLOADS, { ...TUS, 'upload-length': String(this.file.size),
      'upload-metadata': `source ${b64(source)},path ${b64(path)},onCollision ${b64(policy)}` });
    const location = res.headers.get('location');
    if (!location) throw new ApiFailure('INTERNAL');
    return location;
  }

  private async patch(url: string, offset: number, chunk: Blob): Promise<number> {
    const x = sendXhr('PATCH', url, { ...TUS, 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' },
      chunk, (loaded) => this.onProgress(offset + loaded));
    this.xhr = x;
    try {
      const r = await x.done;
      const next = Number(r.header('upload-offset'));
      if (!Number.isSafeInteger(next) || (chunk.size > 0 && next <= offset)) throw new ApiFailure('INTERNAL');
      return next;
    } finally {
      this.xhr = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
    });
  }
}
