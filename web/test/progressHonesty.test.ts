import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { TransferJob } from '@files/shared';
import en from '../src/i18n/en.json';
import { routes } from '../src/router.ts';
import UploadPanel from '../src/components/UploadPanel.vue';
import TransferPanel from '../src/components/TransferPanel.vue';
import MigrationJobView from '../src/views/MigrationJobView.vue';
import { useUploadsStore, type UploadItem } from '../src/stores/uploads.ts';
import { useTransfersStore } from '../src/stores/transfers.ts';
import { useConnectionsStore } from '../src/stores/connections.ts';

// #242 U3: progress never rounds in the flattering direction. 99.6 % reads "99 %", and 100 % belongs to the done state
// only; a running upload or job that has sent everything still reads 99 %.
const i18n = () => createI18n({ legacy: false, locale: 'en', messages: { en } });
beforeEach(() => { setActivePinia(createPinia()); });

const ID = 'a'.repeat(32);
const job = (over: Partial<TransferJob>): TransferJob => ({
  id: ID, kind: 'migration', origin: null, mode: 'copy', from: 'conn:x', to: 'home', dir: '/', name: 'Fotos',
  status: 'running', total: 1000, done: 996, verifiedFiles: 996, files: 1000, listing: false, cancelled: 0, failed: [],
  bytes: 0, createdAt: '2026-10-16T00:00:00.000Z', finishedAt: null, ...over,
});
const values = (w: ReturnType<typeof mount>) => w.findAll('[role=progressbar]').map((b) => b.attributes('aria-valuenow'));

describe('progress honesty', () => {
  it('the upload panel floors a running upload and keeps 100 % for the done state', () => {
    const uploads = useUploadsStore();
    const item = (id: number, sent: number, state: UploadItem['state']): UploadItem =>
      ({ id, batch: 0, name: `f${id}.bin`, size: 1000, sent, state, error: null });
    uploads.items = [item(1, 996, 'uploading'), item(2, 1000, 'uploading'), item(3, 1000, 'done')];
    const w = mount(UploadPanel, { global: { plugins: [i18n()] } });
    expect(values(w)).toEqual(['99', '99', '100']);
    expect(w.findAll('.upload-state').map((s) => s.text())).toEqual(['99%', '99%', 'Uploaded']); // English: no space (#247)
    w.unmount();
  });

  it('the transfer panel floors a running job', () => {
    useTransfersStore().jobs = [job({ kind: 'transfer', done: 199, total: 200 }), job({ id: 'b'.repeat(32), status: 'completed', done: 200, total: 200 })];
    const w = mount(TransferPanel, { global: { plugins: [i18n()] } });
    expect(values(w)).toEqual(['99', '100']);
    w.unmount();
  });

  it('the migration page floors a running migration', async () => {
    useConnectionsStore().loaded = true;
    useTransfersStore().jobs = [job({})];
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push(`/migrate/${ID}`);
    const w = mount(MigrationJobView, { global: { plugins: [i18n(), router] } });
    await flushPromises();
    expect(values(w)).toEqual(['99']);
    w.unmount();
  });
});
