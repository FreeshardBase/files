import { defineStore } from 'pinia';
import type { CollisionPolicy, ErrorCode } from '@files/shared';
import { ApiFailure } from '../api/client.ts';
import { ResumableUpload } from '../api/tus.ts';
import { DirectUpload } from '../api/directUpload.ts';
import { join } from './folder.ts';
import type { CollisionChoice } from '../components/CollisionDialog.vue';

export type UploadState = 'queued' | 'uploading' | 'paused' | 'done' | 'skipped' | 'failed' | 'cancelled';
export type UploadItem = {
  id: number; batch: number;
  /** Shown in the panel: the path below the folder it was uploaded into (`Album/2026/a.jpg` for a folder upload). */
  name: string;
  size: number; sent: number; state: UploadState; error: ErrorCode | 'NETWORK' | null;
};
/** One pick or drop: what the status line reports once every item in it has an outcome. */
export type BatchSummary = { total: number; done: number; skipped: number; failed: number };
export type Question = { id: number; name: string; remaining: number; returnFocus?: HTMLElement | null; answer(c: CollisionChoice): void };
export type PickedFile = { file: File; rel: string };

const FINAL: ReadonlySet<UploadState> = new Set(['done', 'skipped', 'failed', 'cancelled']);

// Outside the reactive state: File objects and upload handles are not data for the view.
type Batch = { forAll: CollisionChoice['policy'] | null; returnFocus?: HTMLElement | null; settled(s: BatchSummary): void };
const batches = new Map<number, Batch>();
const jobs = new Map<number, { upload: ResumableUpload | DirectUpload; policy: CollisionPolicy | null }>();
let nextId = 1;
let pumping = false;

export const useUploadsStore = defineStore('uploads', {
  state: () => ({ items: [] as UploadItem[], question: null as Question | null }),
  getters: {
    failed: (s) => s.items.filter((i) => i.state === 'failed'),
    active: (s) => s.items.some((i) => i.state === 'queued' || i.state === 'uploading'),
  },
  actions: {
    /**
     * Queues files for `at` (captured by the caller, so navigating away does not redirect them). Items run one after
     * another; `settled` is called whenever every item of this batch has an outcome (again after a retry).
     */
    enqueue(files: PickedFile[], at: { source: string; dir: string },
      opts: { returnFocus?: HTMLElement | null; settled(s: BatchSummary): void }) {
      const batch = nextId++;
      batches.set(batch, { forAll: null, returnFocus: opts.returnFocus, settled: opts.settled });
      for (const f of files) {
        const id = nextId++;
        this.items.push({ id, batch, name: f.rel, size: f.file.size, sent: 0, state: 'queued', error: null });
        const target = { source: at.source, path: join(at.dir, f.rel) };
        const progress = (sent: number) => {
          const item = this.item(id);
          if (item) item.sent = sent;
        };
        // tus places only into the home; a cloud connection gets one streaming PUT, passed on to the provider's session.
        const upload = at.source === 'home' ? new ResumableUpload(f.file, target, progress) : new DirectUpload(f.file, target, progress);
        jobs.set(id, { upload, policy: null });
      }
      void this.pump();
    },
    pause(id: number) {
      const item = this.item(id);
      if (item?.state === 'queued') item.state = 'paused';
      else if (item?.state === 'uploading') jobs.get(id)!.upload.pause(); // run() resolves 'paused'
    },
    resume(id: number) {
      const item = this.item(id);
      if (item?.state !== 'paused') return;
      item.state = 'queued';
      void this.pump();
    },
    retry(id: number) {
      const item = this.item(id);
      if (item?.state !== 'failed') return;
      item.state = 'queued'; item.error = null;
      void this.pump();
    },
    retryFailed() {
      for (const item of this.items) if (item.state === 'failed') { item.state = 'queued'; item.error = null; }
      void this.pump();
    },
    /** Stops the item and drops what the server holds of it. */
    async cancel(id: number) {
      const item = this.item(id);
      if (!item || FINAL.has(item.state)) return;
      item.state = 'cancelled';
      this.settle(item.batch);
      await jobs.get(id)!.upload.discard().catch((e: unknown) => {
        if (!(e instanceof ApiFailure)) throw e; // handled: the server drops an abandoned upload when it expires
      });
    },
    /** Removes finished items from the panel; what the server still holds of failed ones is dropped. */
    clearFinished() {
      for (const item of this.items.filter((i) => FINAL.has(i.state))) {
        const job = jobs.get(item.id)!;
        if (item.state === 'failed') {
          void job.upload.discard().catch((e: unknown) => {
            if (!(e instanceof ApiFailure)) throw e; // handled: the server drops an abandoned upload when it expires
          });
        }
        jobs.delete(item.id);
      }
      this.items = this.items.filter((i) => !FINAL.has(i.state));
      for (const id of batches.keys()) if (!this.items.some((i) => i.batch === id)) batches.delete(id);
    },
    item(id: number): UploadItem | undefined { return this.items.find((i) => i.id === id); },

    // One item at a time, in order: the collision question needs the user's answer before the next item starts.
    async pump() {
      if (pumping) return;
      pumping = true;
      try {
        for (let next = this.items.find((i) => i.state === 'queued'); next; next = this.items.find((i) => i.state === 'queued')) {
          await this.runItem(next.id);
        }
      } finally {
        pumping = false;
      }
    },
    async runItem(id: number) {
      const item = this.item(id)!; const job = jobs.get(id)!; const batch = batches.get(item.batch)!;
      item.state = 'uploading'; item.error = null;
      let outcome: UploadState;
      try {
        const first: CollisionPolicy = job.policy ?? (batch.forAll === 'replace' || batch.forAll === 'keep-both' ? batch.forAll : 'fail');
        const r = await job.upload.run(first).catch(async (e: unknown) => {
          if (!(e instanceof ApiFailure && e.code === 'FILE_EXISTS')) throw e;
          let policy: CollisionChoice['policy'] = 'skip'; // forAll is null or "skip" here
          if (!batch.forAll) {
            const remaining = this.items.filter((i) => i.batch === item.batch && i.state === 'queued').length;
            const c = await this.ask(typeof e.params?.name === 'string' ? e.params.name : item.name, remaining, batch.returnFocus);
            policy = c.policy; if (c.all) batch.forAll = c.policy;
          }
          if (policy === 'skip') { await job.upload.discard(); return 'skipped' as const; }
          job.policy = policy; // a resume after a pause keeps the answer
          return job.upload.run(policy);
        });
        outcome = r;
      } catch (e) {
        if (!(e instanceof ApiFailure)) throw e;
        outcome = 'failed';
        item.error = e.code;
      }
      if ((item.state as UploadState) === 'cancelled') return; // cancel() changed it meanwhile and already settled the batch
      item.state = outcome;
      if (outcome === 'done') item.sent = item.size;
      this.settle(item.batch);
    },
    ask(name: string, remaining: number, returnFocus?: HTMLElement | null): Promise<CollisionChoice> {
      return new Promise((resolve) => {
        this.question = { id: nextId++, name, remaining, returnFocus, answer: (c) => { this.question = null; resolve(c); } };
      });
    },
    settle(batchId: number) {
      const own = this.items.filter((i) => i.batch === batchId);
      if (!own.every((i) => FINAL.has(i.state))) return;
      const count = (s: UploadState) => own.filter((i) => i.state === s).length;
      batches.get(batchId)?.settled({ total: own.length, done: count('done'), skipped: count('skipped'), failed: count('failed') });
    },
  },
});
