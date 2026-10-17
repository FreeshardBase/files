import { expect, test, type Page } from '@playwright/test';

// #236 against the cloud server (e2e/cloudServer.ts): a connection's page title (P3) and the size of a Google-native
// document (P4), whose fake Drive holds the Google Sheet "Budget".
test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

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

test('#236 P3: a connection\'s page is titled by its provider and folder, never by its id', async ({ page }) => {
  await signedIn(page);
  await expect(page).toHaveTitle(/^(Cloud-Konten|Cloud accounts) – (Dateien|Files)$/);
  await page.getByRole('button', { name: /Fake Cloud verbinden|Connect Fake Cloud/ }).click();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  await expect(page).toHaveTitle(/^Fake Cloud – (Dateien|Files)$/);
  await row(page, 'Notes').getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}\/Notes$/);
  await expect(page).toHaveTitle(/^Notes – (Dateien|Files)$/);
});

test('#236 P4: a Google-native document shows "–" for its size, in the list and in the details', async ({ page }) => {
  await signedIn(page);
  await page.getByRole('button', { name: /Google Drive verbinden|Connect Google Drive/ }).click();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  await expect(row(page, 'Budget.xlsx')).toBeVisible();
  await expect(row(page, 'Budget.xlsx').locator('td.size')).toHaveText('–');
  await expect(row(page, 'Budget.xlsx')).not.toContainText(/0 Byte|0 byte/);
  await row(page, 'Budget.xlsx').getByRole('button', { name: /Aktionen für|Actions for/ }).click();
  await page.getByRole('menuitem', { name: /^Details$/ }).click();
  const facts = page.getByRole('dialog', { name: 'Details Budget.xlsx', exact: true }).locator('.details-facts');
  await expect(facts.locator('dt', { hasText: /^(Größe|Size)$/ }).locator('xpath=following-sibling::dd[1]')).toHaveText('–');
  // A stored file keeps its real size.
  await page.keyboard.press('Escape');
  await row(page, 'Photos').getByRole('button', { name: 'Photos', exact: true }).click();
  await expect(row(page, 'sunset.png').locator('td.size')).not.toHaveText('–');
});
