import { expect, test, type Page } from '@playwright/test';

// #148: connecting a cloud account through the provider's consent page, the connection in the sidebar, and unlinking
// it after an <AppDialog> confirmation. Runs against the cloud server (e2e/cloudServer.ts), whose one provider is the
// fake one (consent page "Fake Cloud", accounts testuser@example.com and member@example.com).
test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const sidebarConnection = (page: Page) => nav(page).getByRole('link', { name: /testuser@example\.com/ });
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
  await expect(page.getByText(/noch kein Cloud-Konto verbunden|not connected a cloud account yet/)).toBeVisible();
}

test('connect an account on the fake consent page, see it in the sidebar, open it, and unlink it after confirming', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await signedIn(page);
  await expect(sidebarConnection(page)).toHaveCount(0);

  await page.getByRole('button', { name: /Fake Cloud verbinden|Connect Fake Cloud/ }).click();
  // The provider's own page, on the provider's origin.
  await expect(page).toHaveURL(/\/oauth\/authorize\?/);
  await expect(page.getByRole('heading', { name: 'Fake Cloud' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow' }).click();

  // Back in Files: the new connection opens, its files are listed live, and it is in the sidebar.
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  await expect(row(page, 'Notes')).toBeVisible();
  await expect(row(page, 'report.txt')).toBeVisible();
  await expect(sidebarConnection(page)).toBeVisible();
  await expect(sidebarConnection(page)).toContainText('Fake Cloud');
  await expect(sidebarConnection(page)).toHaveClass(/active/);
  await row(page, 'Notes').getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}\/Notes$/);
  await expect(row(page, 'hello.txt')).toBeVisible();

  await nav(page).getByRole('link', { name: /Cloud-Konten|Cloud accounts/ }).click();
  const conn = page.locator('tbody tr', { hasText: 'testuser@example.com' });
  await expect(conn).toContainText(/Verbunden|Connected/);
  await expect(conn).toContainText('Fake Cloud');

  // Unlink asks first in an <AppDialog>; Cancel has the focus and Esc keeps the connection.
  const unlink = conn.getByRole('button', { name: /testuser@example\.com trennen|Unlink testuser@example\.com/ });
  await unlink.click();
  const confirm = page.getByRole('dialog', { name: /testuser@example\.com trennen\?|Unlink testuser@example\.com\?/ });
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveAttribute('aria-modal', 'true');
  await expect(confirm).toContainText(/funktionieren danach nicht mehr|stop working/);
  await expect(confirm.getByRole('button', { name: /Abbrechen|Cancel/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(unlink).toBeFocused();
  await expect(sidebarConnection(page)).toBeVisible();

  await unlink.click();
  await confirm.getByRole('button', { name: /^(Trennen|Unlink)$/ }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText(/testuser@example\.com getrennt|testuser@example\.com unlinked/);
  await expect(conn).toHaveCount(0);
  await expect(sidebarConnection(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeFocused();
  expect((await (await page.request.get('/api/v1/connections')).json()).items).toEqual([]);
  expect(dialogs).toEqual([]);
});

test('a denied consent comes back to "Cloud accounts" with a message and connects nothing', async ({ page }) => {
  await signedIn(page);
  await page.getByRole('button', { name: /Fake Cloud verbinden|Connect Fake Cloud/ }).click();
  await expect(page.getByRole('heading', { name: 'Fake Cloud' })).toBeVisible();
  await page.getByRole('button', { name: 'Deny' }).click();
  await expect(page).toHaveURL(/\/connections$/); // the error code is shown, then dropped from the URL
  await expect(page.getByRole('alert')).toContainText(/konnte nicht verbunden werden|could not be connected/);
  await expect(sidebarConnection(page)).toHaveCount(0);
  expect((await (await page.request.get('/api/v1/connections')).json()).items).toEqual([]);
});
