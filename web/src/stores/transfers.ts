import { defineStore } from 'pinia';
import type { CreateTransferRequest, RenameRequest, TransferJob } from '@files/shared';
import { api, ApiFailure } from '../api/client.ts';

let events: EventSource | null = null;
/** How long an ended job shows in full once seen (#234), like a finished upload batch (#233). */
export const SETTLED_MS = 5000;
const seenTimers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * An ended job that leaves the panel by itself once seen: it completed or was cancelled. A failed one stays (folded) until
 * dismissed, and so does a migration, whose page offers the cleanup of its originals, and an import, whose page shows what
 * it skipped (#322); its panel row links to that page, which restores the latest import (#354).
 */
export const clearsItself = (j: TransferJob) => (j.status === 'completed' || j.status === 'cancelled')
  && j.kind !== 'migration' && j.kind !== 'import';

/**
 * The member's transfer jobs between sources (#152): live from the server's event stream, which starts with the
 * current jobs and then sends every change. Newest first.
 */
export const useTransfersStore = defineStore('transfers', {
  state: () => ({
    jobs: [] as TransferJob[],
    // The job that ended last; the folder view relists when it touched the folder it shows.
    lastSettled: null as TransferJob | null,
    // Ended jobs folded into the panel's one-line summary (#234), by id.
    folded: [] as string[],
  }),
  getters: {
    finished: (s) => s.jobs.some((j) => j.status !== 'running'),
  },
  actions: {
    /** Opens the event stream once; the browser reconnects by itself and the server then sends the jobs again. */
    connect() {
      if (events) return;
      events = new EventSource('/api/v1/transfers/events');
      events.addEventListener('job', (e) => { this.apply(JSON.parse((e as MessageEvent<string>).data) as TransferJob); });
    },
    apply(job: TransferJob) {
      const i = this.jobs.findIndex((j) => j.id === job.id);
      const was = i < 0 ? undefined : this.jobs[i]!;
      // A job only ever leaves `running`; an answer that arrives after a later event must not take it back.
      if (was && was.status !== 'running' && job.status === 'running') return;
      if (i < 0) this.jobs.unshift(job); else this.jobs[i] = job;
      if (job.status !== 'running' && was?.status !== job.status) this.lastSettled = job;
    },
    async start(req: CreateTransferRequest): Promise<TransferJob> {
      const job = await api.post<TransferJob>('/api/v1/transfers', req);
      this.apply(job);
      return job;
    },
    /** A batch rename (#215): the job the server started from the plan the dialog showed. */
    async rename(req: RenameRequest): Promise<TransferJob> {
      const job = await api.post<TransferJob>('/api/v1/renames', req);
      this.apply(job);
      return job;
    },
    async cancel(id: string) {
      this.apply(await api.post<TransferJob>(`/api/v1/transfers/${encodeURIComponent(id)}/cancel`, {}));
    },
    /**
     * The panel showed the ended job `id` on a visible page (#234): after SETTLED_MS it leaves the panel if it clears
     * itself, otherwise it folds into the summary. Once per job.
     */
    seen(id: string) {
      if (seenTimers.has(id) || this.folded.includes(id)) return;
      seenTimers.set(id, setTimeout(() => {
        seenTimers.delete(id); // the job now leaves or is folded, and a folded one is never timed again
        const job = this.jobs.find((j) => j.id === id);
        if (!job) return;
        if (!clearsItself(job)) { this.folded.push(id); return; }
        this.dismiss(id).catch((e: unknown) => { // handled: the job folds instead and leaves with "Clear finished"
          if (!(e instanceof ApiFailure)) throw e;
          this.folded.push(id);
        });
      }, SETTLED_MS));
    },
    /** Removes one finished job (#234). One another tab or device removed already is gone here too. */
    async dismiss(id: string) {
      try { await api.post(`/api/v1/transfers/${encodeURIComponent(id)}/dismiss`, {}); }
      catch (e) { // handled: a job the server no longer has leaves the list like a dismissed one; anything else is rethrown
        if (!(e instanceof ApiFailure && e.code === 'NOT_FOUND')) throw e;
      }
      this.jobs = this.jobs.filter((j) => j.id !== id);
      this.folded = this.folded.filter((f) => f !== id);
    },
    async clearFinished() {
      await api.post('/api/v1/transfers/clear', {});
      this.jobs = this.jobs.filter((j) => j.status === 'running');
      this.folded = [];
    },
  },
});
