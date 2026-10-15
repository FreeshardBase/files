import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openPlaces } from './places.ts';

// #150: a Dropbox connection, browsed live through the same folder view as the home. Runs against the cloud server
// (e2e/cloudServer.ts), whose Dropbox provider talks to the fake Dropbox (server/test/support/fakeDropbox.ts):
// /Reports/Q3 Übersicht.txt.
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

test('browse a Dropbox connection and download a file with the same bytes', async ({ page }) => {
  const fakeRequests: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/dropbox/')) fakeRequests.push(r.url()); });
  await signedIn(page);
  await page.getByRole('button', { name: /Dropbox verbinden|Connect Dropbox/ }).click();
  await expect(page.getByRole('heading', { name: 'Fake Cloud' })).toBeVisible(); // the fake's consent page stands in for Dropbox's
  await page.getByRole('button', { name: 'Allow' }).click();

  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  await openPlaces(page);
  await expect(nav(page).getByRole('link', { name: /testuser@example\.com/ })).toContainText('Dropbox');
  // Dropbox keeps no time for a folder, so its row shows none instead of a made-up date.
  await expect(row(page, 'Reports')).toBeVisible();
  await expect(row(page, 'Reports').locator('td.date')).toHaveText('');
  await row(page, 'Reports').getByRole('button', { name: 'Reports', exact: true }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}\/Reports$/);

  const name = 'Q3 Übersicht.txt';
  await expect(row(page, name).locator('td.date')).not.toHaveText('');
  await page.getByRole('link', { name, exact: true }).click();
  const preview = page.getByRole('dialog', { name, exact: true });
  await expect(preview.locator('pre')).toHaveText('third quarter, from dropbox');
  const [download] = await Promise.all([page.waitForEvent('download'),
    preview.getByRole('link', { name: /^(Herunterladen|Download)$/ }).click()]);
  expect(download.suggestedFilename()).toBe(name);
  expect(readFileSync(await download.path()).toString()).toBe('third quarter, from dropbox');

  // The browser only ever talked to the shard.
  expect(fakeRequests).toEqual([]);
});
