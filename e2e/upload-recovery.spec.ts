import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { writeFileSync } from 'node:fs';

// #233: leaving the page while uploads run asks first; after a reload the uploads left unfinished are listed with
// Resume (pick the file again) and Discard (frees the reserved quota); a batch that finished without a failure leaves
// the panel after a few seconds.

const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const MiB = 1024 ** 2;
const panel = (page: Page) => page.getByTestId('upload-panel');
const item = (page: Page, name: string) => panel(page).locator('.upload-item', { has: page.locator('.upload-name').getByText(name, { exact: true }) });
const unfinished = (page: Page) => panel(page).getByRole('region', { name: /Unterbrochene Uploads|Unfinished uploads/ });
const unfinishedRow = (page: Page, shown: string) =>
  unfinished(page).locator('.upload-item', { has: page.locator('.upload-name').getByText(shown, { exact: true }) });
// What a page about to be left is told: true when the app asks the browser to confirm.
const leavingAsks = (page: Page) => page.evaluate(() => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
});
type OpenUpload = { id: string; path: string; length: number; offset: number };
const openUploads = async (page: Page): Promise<OpenUpload[]> => (await (await page.request.get('/api/v1/uploads')).json()).items;

async function openFolder(page: Page, dir: string) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const headers = await mutating(page);
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toContainText(dir);
}
async function mutating(page: Page) {
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  return { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
}
/** Holds back every PATCH; they go on with `release`. */
async function holdPatches(page: Page) {
  const held: Route[] = [];
  await page.route('**/api/v1/uploads/*', (route) => (route.request().method() === 'PATCH' ? void held.push(route) : route.continue()));
  return { held, release: async () => { for (const r of held) await r.continue(); await page.unrouteAll(); } };
}

test('leaving the page while an upload runs asks first, and not once it is done', async ({ page }, info) => {
  const dir = `leave-${tag(info)}`;
  await openFolder(page, dir);
  expect(await leavingAsks(page)).toBe(false);
  const patches = await holdPatches(page);
  await page.getByTestId('upload-input').setInputFiles({ name: 'slow.txt', mimeType: 'text/plain', buffer: Buffer.from('slow') });
  await expect.poll(() => patches.held.length).toBe(1);
  await expect(item(page, 'slow.txt')).toHaveAttribute('data-state', 'uploading');
  expect(await leavingAsks(page)).toBe(true);
  await patches.release();
  await expect(item(page, 'slow.txt')).toHaveAttribute('data-state', 'done');
  expect(await leavingAsks(page)).toBe(false);
});

test('after a reload an interrupted upload is listed, and picking the file again continues where it stopped', async ({ page }, info) => {
  const dir = `resume-${tag(info)}`;
  const film = info.outputPath('film.bin');
  writeFileSync(film, Buffer.alloc(9 * MiB, 7));
  await openFolder(page, dir);
  // The first 8 MiB chunk arrives; the connection drops for the rest, and the page is reloaded.
  let patches = 0;
  await page.route('**/api/v1/uploads/*', (route) =>
    (route.request().method() === 'PATCH' && ++patches > 1 ? route.abort('internetdisconnected') : route.continue()));
  await page.getByTestId('upload-input').setInputFiles(film);
  await expect(item(page, 'film.bin')).toHaveAttribute('data-state', 'failed');
  expect((await openUploads(page)).find((u) => u.path === `/${dir}/film.bin`)?.offset).toBe(8 * MiB);
  await page.unrouteAll();
  await page.reload();

  const row = unfinishedRow(page, `${dir}/film.bin`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(/(von|of)/);
  await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '88');
  const offsets: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH') offsets.push(r.headers()['upload-offset'] ?? ''); });
  await row.getByLabel(/(film\.bin fortsetzen|Resume upload of .*film\.bin)/).setInputFiles(film);
  await expect(item(page, 'film.bin')).toHaveAttribute('data-state', 'done');
  expect(offsets).toEqual([String(8 * MiB)]);
  await expect(row).toHaveCount(0);
  const stat = await (await page.request.get(`/api/v1/sources/home/stat?path=${encodeURIComponent(`/${dir}/film.bin`)}`)).json();
  expect(stat.size).toBe(9 * MiB);
  expect((await openUploads(page)).filter((u) => u.path.startsWith(`/${dir}/`))).toEqual([]);
});

test('an unfinished upload can be discarded, which frees its reserved quota; another file does not resume it', async ({ page }, info) => {
  const dir = `discard-${tag(info)}`;
  await openFolder(page, dir);
  // An upload an earlier page left behind: 3 of 5 MiB arrived.
  const headers = { ...await mutating(page), 'tus-resumable': '1.0.0' };
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const created = await page.request.post('/api/v1/uploads', { headers: { ...headers, 'upload-length': String(5 * MiB),
    'upload-metadata': `source ${b64('home')},path ${b64(`/${dir}/old.iso`)}` } });
  expect(created.status()).toBe(201);
  const url = created.headers().location!;
  const sent = await page.request.patch(url, { headers: { ...headers, 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' },
    data: Buffer.alloc(3 * MiB, 1) });
  expect(sent.status()).toBe(204);
  const usage = async () => (await (await page.request.get('/api/v1/storage')).json()).home.usage.uploads as number;
  const before = await usage();
  await page.reload();

  const row = unfinishedRow(page, `${dir}/old.iso`);
  await expect(row).toBeVisible();
  // Another file is not this upload: nothing is sent, the row stays and the panel says so.
  await row.getByLabel(/(old\.iso fortsetzen|Resume upload of .*old\.iso)/)
    .setInputFiles({ name: 'other.iso', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
  await expect(unfinished(page).getByRole('alert')).toContainText(/(nicht die Datei|not the file)/);
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: /(old\.iso verwerfen|Discard upload of .*old\.iso)/ }).click();
  await expect(row).toHaveCount(0);
  expect((await openUploads(page)).map((u) => u.path)).not.toContain(`/${dir}/old.iso`);
  expect(await usage()).toBe(before - 3 * MiB);
});

test('a finished batch leaves the panel after a few seconds; a failed one stays for its retry', async ({ page }, info) => {
  const dir = `collapse-${tag(info)}`;
  await openFolder(page, dir);
  await page.route('**/api/v1/uploads', (route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue()));
  await page.getByTestId('upload-input').setInputFiles({ name: 'fails.txt', mimeType: 'text/plain', buffer: Buffer.from('no') });
  await expect(item(page, 'fails.txt')).toHaveAttribute('data-state', 'failed');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.getByTestId('upload-input').setInputFiles({ name: 'fine.txt', mimeType: 'text/plain', buffer: Buffer.from('ok') });
  await expect(item(page, 'fine.txt')).toHaveAttribute('data-state', 'done');
  await expect(item(page, 'fine.txt')).toHaveCount(0, { timeout: 15_000 });
  // Older than the finished batch, and still there.
  await expect(item(page, 'fails.txt')).toHaveAttribute('data-state', 'failed');
  await panel(page).getByRole('button', { name: /^(Erledigte entfernen|Clear finished)$/ }).click();
  await expect(item(page, 'fails.txt')).toHaveCount(0);
});
