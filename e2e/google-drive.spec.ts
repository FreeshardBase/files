import { expect, test, type Page } from '@playwright/test';

// #149: a Google Drive connection, browsed live through the same folder view as the home. Runs against the cloud server
// (e2e/cloudServer.ts), whose Google Drive provider talks to the fake Drive (server/test/support/fakeDrive.ts):
// /Photos/sunset.png (400×300, with a Drive thumbnail) and the Google Sheet "Budget".
test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const row = (page: Page, name: string) => page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });

/** Signs in as testuser and removes connections an earlier test or project left (both projects share the server). */
async function signedIn(page: Page) {
  await page.goto('/auth/login?returnTo=%2Fconnections');
  await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
    expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
  }
  await page.reload();
}

test('browse a Google Drive connection, preview an image, upload a file and see it listed', async ({ page }, info) => {
  const fakeOrigins = new Set<string>();
  page.on('request', (r) => { if (/\/(drive|upload\/drive)\/v3\/|drive-(thumb|blob)/.test(r.url())) fakeOrigins.add(r.url()); });
  await signedIn(page);
  await page.getByRole('button', { name: /Google Drive verbinden|Connect Google Drive/ }).click();
  await expect(page.getByRole('heading', { name: 'Fake Cloud' })).toBeVisible(); // the fake's consent page stands in for Google's
  await page.getByRole('button', { name: 'Allow' }).click();

  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  await expect(nav(page).getByRole('link', { name: /testuser@example\.com/ })).toContainText('Google Drive');
  await expect(row(page, 'Photos')).toBeVisible();
  // A Google Sheet is listed as the office file it downloads as.
  await expect(row(page, 'Budget.xlsx')).toBeVisible();
  await row(page, 'Photos').getByRole('button', { name: 'Photos', exact: true }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}\/Photos$/);

  // The row's thumbnail is Drive's, proxied by the shard as a WebP.
  const thumb = row(page, 'sunset.png').locator('img.row-thumb');
  await expect(thumb).toHaveAttribute('src', /^\/api\/v1\/sources\/conn%3A[0-9a-f]{32}\/thumbnail\?/);
  await expect.poll(() => thumb.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(128);

  await page.getByRole('link', { name: 'sunset.png', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'sunset.png', exact: true });
  await expect(preview).toBeVisible();
  const img = preview.getByRole('img', { name: 'sunset.png' });
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(400);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);

  const name = `note-${info.project.name}.txt`;
  await page.getByTestId('upload-input').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('hello, drive') });
  await expect(row(page, name)).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /1 von 1 hochgeladen|1 of 1 uploaded/ })).toBeVisible();
  const source = decodeURIComponent(new URL(page.url()).pathname.split('/')[1]!);
  const down = await page.request.get(`/api/v1/sources/${encodeURIComponent(source)}/content?path=${encodeURIComponent(`/Photos/${name}`)}`);
  expect(await down.text()).toBe('hello, drive');

  // The browser only ever talked to the shard.
  expect([...fakeOrigins]).toEqual([]);
});
