import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openPlaces } from './places.ts';

// #211: pCloud in "Cloud accounts", with its own line icon, connected and browsed live through the same folder view as
// the home. Runs against the cloud server (e2e/cloudServer.ts), whose pCloud provider talks to the fake pCloud
// (server/test/support/fakePcloud.ts): /Travel/Packliste Ägäis.txt.
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

/** The CSS mask (the glyph) of an icon inside a connect button. */
const glyph = (page: Page, provider: RegExp) => page.getByRole('button', { name: provider }).locator('.icon')
  .evaluate((el) => getComputedStyle(el).getPropertyValue('mask-image') || getComputedStyle(el).getPropertyValue('-webkit-mask-image'));

test('connect pCloud from its own button and download a file with the same bytes', async ({ page }) => {
  const fakeRequests: string[] = [];
  page.on('request', (r) => { if (/\/pcloud(-content)?\//.test(r.url()) && !r.url().includes('/pcloud/oauth2/')) fakeRequests.push(r.url()); });
  await signedIn(page);

  // The button carries a line icon of its own, hidden from screen readers; the others keep the plain cloud.
  const connect = page.getByRole('button', { name: /pCloud verbinden|Connect pCloud/ });
  await expect(connect).toBeVisible();
  const icon = connect.locator('.icon');
  await expect(icon).toHaveAttribute('aria-hidden', 'true');
  await expect(icon).toBeVisible();
  const own = await glyph(page, /pCloud verbinden|Connect pCloud/);
  expect(own).toMatch(/^url\("data:image\/svg\+xml/);
  expect(own).not.toBe(await glyph(page, /Dropbox verbinden|Connect Dropbox/));

  await connect.click();
  await expect(page.getByRole('heading', { name: 'Fake pCloud' })).toBeVisible(); // the fake's consent page stands in for pCloud's
  await page.getByRole('button', { name: 'Allow' }).click();

  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  await openPlaces(page);
  await expect(nav(page).getByRole('link', { name: /testuser@example\.com/ })).toContainText('pCloud');
  await expect(row(page, 'Travel')).toBeVisible();
  await row(page, 'Travel').getByRole('button', { name: 'Travel', exact: true }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}\/Travel$/);

  const name = 'Packliste Ägäis.txt';
  await page.getByRole('link', { name, exact: true }).click();
  const preview = page.getByRole('dialog', { name, exact: true });
  await expect(preview.locator('pre')).toHaveText('sunscreen, from pcloud');
  const [download] = await Promise.all([page.waitForEvent('download'),
    preview.getByRole('link', { name: /^(Herunterladen|Download)$/ }).click()]);
  expect(download.suggestedFilename()).toBe(name);
  expect(readFileSync(await download.path()).toString()).toBe('sunscreen, from pcloud');

  // The browser only ever talked to the shard (and to the consent page).
  expect(fakeRequests).toEqual([]);
});
