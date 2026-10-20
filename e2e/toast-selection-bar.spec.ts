import { expect, test, type Page, type TestInfo } from '@playwright/test';

// #405: on the phone the toast sits above the fixed selection sheet, so every action in the sheet stays reachable
// while it shows.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const crumbs = (page: Page) => page.getByRole('navigation', { name: /Pfad|Path/ });
const bar = (page: Page) => page.getByRole('group', { name: /^(Aktionen für die Auswahl|Actions for the selection)$/ });

test('#405 the toast does not cover the selection sheet on the phone', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('mobile'), 'the sheet is fixed at the bottom only on the phone');
  const dir = `toast-sheet-${tag(info)}`;
  await page.goto('/');
  await expect(crumbs(page)).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(crumbs(page)).toContainText(dir);

  await page.getByRole('button', { name: /^(Hochladen|Upload)$/ }).and(page.locator('[aria-haspopup="menu"]')).click();
  await page.getByRole('menuitem', { name: /^(Neuer Ordner|New folder)$/ }).click();
  const d = page.getByRole('dialog', { name: /Neuer Ordner|New folder/ });
  await d.getByRole('textbox').fill('Sub');
  await d.getByRole('textbox').press('Enter');
  await expect(d).toHaveCount(0);

  const toast = page.locator('.toast.shown');
  await expect(toast).toContainText(/Sub/);
  await expect(bar(page)).toBeVisible();
  const trash = bar(page).getByRole('button', { name: /^(In den Papierkorb|Move to trash)$/ });
  await expect(trash).toBeVisible();

  const t = (await toast.boundingBox())!;
  const b = (await bar(page).boundingBox())!;
  expect(t.y + t.height).toBeLessThanOrEqual(b.y + 0.5);
  await trash.click({ trial: true, timeout: 2000 });
});
