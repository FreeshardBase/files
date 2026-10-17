import { defineStore } from 'pinia';
import type { CreateTransferRequest, RenameRequest, TransferJob } from '@files/shared';
import { api } from '../api/client.ts';

let events: EventSource | null = null;

/**
 * The member's transfer jobs between sources (#152): live from the server's event stream, which starts with the
 * current jobs and then sends every change. Newest first.
 */
export const useTransfersStore = defineStore('transfers', {
  state: () => ({
    jobs: [] as TransferJob[],
    // The job that ended last; the folder view relists when it touched the folder it shows.
    lastSettled: null as TransferJob | null,
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
    async clearFinished() {
      await api.post('/api/v1/transfers/clear', {});
      this.jobs = this.jobs.filter((j) => j.status === 'running');
    },
  },
});
