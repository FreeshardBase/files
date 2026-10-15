import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #140: resumable uploads with one upload panel, an aggregated failure summary (#119) and folder upload.
// Both projects share one server and data dir; every test works in its own folder named after the project and test.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const status = (page: Page) => page.getByRole('status');
const panel = (page: Page) => page.getByTestId('upload-panel');
const item = (page: Page, name: string) => panel(page).locator('.upload-item', { has: page.locator('.upload-name').getByText(name, { exact: true }) });

/** Creates `/<dir>` through the API and opens it; fails the test on any alert/confirm/prompt. */
async function open(page: Page, dir: string): Promise<string[]> {
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const r = await page.request.post('/api/v1/sources/home/mkdir',
    { headers: { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin }, data: { path: `/${dir}` } });
  expect(r.status()).toBe(201);
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toContainText(dir);
  return dialogs;
}
async function download(page: Page, name: string): Promise<Buffer> {
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name, exact: true }).click()]);
  return readFileSync(await d.path());
}

test('uploads a file with progress in the panel; it is listed and downloads with identical bytes', async ({ page }, info) => {
  const dialogs = await open(page, `up-${tag(info)}`);
  const data = randomBytes(3 * 1024 * 1024 + 17);
  await page.getByTestId('upload-input').setInputFiles({ name: 'Prüfung #1 50%.bin', mimeType: 'application/octet-stream', buffer: data });
  await expect(status(page)).toContainText(/1 von 1|1 of 1/);
  const row = item(page, 'Prüfung #1 50%.bin');
  await expect(row.getByRole('progressbar', { name: /Prüfung #1 50%\.bin/ })).toHaveAttribute('aria-valuenow', '100');
  await expect(row).toContainText(/Hochgeladen|Uploaded/);
  await expect(page.getByRole('link', { name: 'Prüfung #1 50%.bin', exact: true })).toBeVisible();
  expect(Buffer.compare(await download(page, 'Prüfung #1 50%.bin'), data)).toBe(0);
  expect(dialogs).toEqual([]);
});

test('with the network gone mid-batch, five uploads end in one summary with "retry all", never an alert', async ({ page }, info) => {
  const dialogs = await open(page, `net-${tag(info)}`);
  // The first file's creation and PATCH get through, then the shard is unreachable.
  let allowed = 2; let blocked = 0;
  await page.route('**/api/v1/uploads**', async (route) => {
    if (allowed-- > 0) return route.continue();
    blocked++;
    return route.abort('internetdisconnected');
  });
  const files = [1, 2, 3, 4, 5].map((i) => ({ name: `f${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`file ${i}`) }));
  await page.getByTestId('upload-input').setInputFiles(files);
  const summary = page.getByTestId('upload-summary');
  await expect(summary).toContainText(/4 Uploads sind fehlgeschlagen|4 uploads failed/, { timeout: 20_000 });
  await expect(summary).toHaveCount(1);
  for (const i of [2, 3, 4, 5]) await expect(summary).toContainText(`f${i}.txt`);
  await expect(status(page)).toContainText(/1 von 5|1 of 5/);
  expect(blocked).toBeGreaterThan(0);
  await expect(page.getByRole('link', { name: 'f1.txt', exact: true })).toBeVisible();

  await page.unroute('**/api/v1/uploads**');
  await summary.getByRole('button', { name: /Alle erneut versuchen|Retry all/ }).click();
  await expect(status(page)).toContainText(/5 von 5|5 of 5/);
  await expect(summary).toHaveCount(0);
  for (const f of files) await expect(page.getByRole('link', { name: f.name, exact: true })).toBeVisible();
  expect((await download(page, 'f4.txt')).toString()).toBe('file 4');
  expect(dialogs).toEqual([]);
});

test('a folder upload recreates a two-level structure', async ({ page }, info) => {
  const dir = `fold-${tag(info)}`;
  const dialogs = await open(page, dir);
  const scratch = mkdtempSync(join(tmpdir(), 'files-e2e-folder-'));
  try {
    const album = join(scratch, 'Album');
    mkdirSync(join(album, 'Sommer 2026'), { recursive: true });
    writeFileSync(join(album, 'a.txt'), 'top level');
    writeFileSync(join(album, 'Sommer 2026', 'b.txt'), 'second level');
    await page.getByTestId('upload-folder-input').setInputFiles(album);
    await expect(status(page)).toContainText(/2 von 2|2 of 2/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  await page.getByRole('button', { name: 'Album', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/home/${dir}/Album$`));
  await expect(page.getByRole('button', { name: 'Sommer 2026', exact: true })).toBeVisible();
  expect((await download(page, 'a.txt')).toString()).toBe('top level');
  await page.getByRole('button', { name: 'Sommer 2026', exact: true }).click();
  expect((await download(page, 'b.txt')).toString()).toBe('second level');
  expect(dialogs).toEqual([]);
});
