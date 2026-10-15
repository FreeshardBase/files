import { expect, test, type Page } from '@playwright/test';

// #152 (regression for #115: paste was hardcoded to the local source): a file copied in a cloud connection is pasted into
// the home. The paste becomes a transfer job, the transfer panel shows it until it is done, and the copy opens. Runs
// against the cloud server (e2e/cloudServer.ts), whose generic fake cloud holds /report.txt ("quarterly numbers").
test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const row = (page: Page, name: string) => page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const panel = (page: Page) => page.getByRole('region', { name: /^(Übertragungen|Transfers)$/ });

/** Signs in as testuser, removes connections and finished transfers an earlier test or project left (one shared server). */
async function signedIn(page: Page) {
  await page.goto('/auth/login?returnTo=%2Fconnections');
  await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
    expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
  }
  expect((await page.request.post('/api/v1/transfers/clear', { headers })).status()).toBe(204);
  await page.reload();
  return headers;
}

test('copy a file from a cloud connection, paste it into the home, watch the transfer and open the copy', async ({ page }, info) => {
  const headers = await signedIn(page);
  const dir = `transfer-${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);

  await page.getByRole('button', { name: /Fake Cloud verbinden|Connect Fake Cloud/ }).click();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  await row(page, 'report.txt').getByRole('button', { name: /(Aktionen für|Actions for) report\.txt/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /^(Kopieren|Copy)$/ }).click();
  await expect(page.getByRole('status')).toContainText(/1 zum Kopieren vorgemerkt|1 ready to copy/);

  // Into another source: the home, in this project's own folder.
  await nav(page).getByRole('link', { name: /Mein Speicher|My storage/ }).click();
  await page.getByRole('button', { name: dir, exact: true }).click();
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toContainText(dir);
  await page.getByRole('button', { name: /Hierher kopieren \(1\)|Copy here \(1\)/ }).click();
  await expect(page.getByRole('status')).toContainText(/Ein Element wird kopiert|Copying one item/);

  await expect(panel(page)).toContainText(/„report\.txt“ nach Mein Speicher\/transfer-|Copy “report\.txt” to My storage\/transfer-/);
  await expect(panel(page).getByRole('progressbar', { name: /report\.txt/ })).toHaveAttribute('aria-valuenow', '100');
  await expect(panel(page)).toContainText(/Fertig|Done/);
  // The folder relists once the job has ended; the copy opens like any file of the home.
  await expect(row(page, 'report.txt')).toBeVisible();
  await page.getByRole('link', { name: 'report.txt', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'report.txt', exact: true });
  await expect(preview).toContainText('quarterly numbers');
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);

  // "Clear finished" empties the panel.
  await panel(page).getByRole('button', { name: /Erledigte entfernen|Clear finished/ }).click();
  await expect(panel(page)).toHaveCount(0);
});
