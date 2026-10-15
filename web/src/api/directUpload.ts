// Uploads into a cloud connection (#149): one streaming `PUT content`, which the server hands on to the provider's own
// resumable session. tus places bytes only in the home (#152), so there is no resume across a reload here: a pause
// aborts the request, and resuming sends the file again from the start.
import type { CollisionPolicy, Entry } from '@files/shared';
import { api, ApiFailure, sendXhr } from './client.ts';
import { sourceApi } from './paths.ts';
import type { RunResult, Target } from './tus.ts';

export class DirectUpload {
  private xhr: { abort(): void } | null = null;
  private paused = false;

  constructor(readonly file: File, readonly target: Target, private onProgress: (sent: number) => void) {}

  /**
   * Sends the file with `policy`. With `fail`, a taken name is asked about first (stat), so the browser never sends a
   * body the server has already refused; the server still refuses one that is taken meanwhile.
   */
  async run(policy: CollisionPolicy): Promise<RunResult> {
    this.paused = false;
    const base = sourceApi(this.target.source);
    if (policy === 'fail') {
      const taken = await api.get<Entry>(`${base}/stat`, { path: this.target.path }).catch((e: unknown) => {
        if (e instanceof ApiFailure && e.code === 'NOT_FOUND') return null; // handled: a free name is what we hope for
        throw e;
      });
      if (taken) throw new ApiFailure('FILE_EXISTS', { name: taken.name });
    }
    if (this.paused) return 'paused';
    const req = sendXhr('PUT', `${base}/content?${new URLSearchParams({ path: this.target.path, onCollision: policy })}`,
      { 'content-type': 'application/octet-stream' }, this.file, (sent) => this.onProgress(sent));
    this.xhr = req;
    try {
      await req.done;
      return 'done';
    } catch (e) {
      if (this.paused) return 'paused'; // handled: abort() after pause() is the pause, not a failure
      throw e;
    } finally {
      this.xhr = null;
    }
  }

  pause(): void {
    this.paused = true;
    this.xhr?.abort();
  }

  /** Nothing is held on the shard between attempts; stopping the request is all there is to drop. */
  async discard(): Promise<void> {
    this.pause();
  }
}
