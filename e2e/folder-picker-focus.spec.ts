import { expect, test, type Page, type TestInfo } from '@playwright/test';

// #366: opening a folder or a crumb in the folder picker re-renders the buttons; the focus moves to the picker's current
// crumb (aria-current=location) instead of falling to <body>, and stays inside the dialog where the picker is in one.
const tag = (info: TestInfo, kind: string) => `picker-${kind}-${info.project.name}-${info.repeatEachIndex}-${info.retry}`;

/** Creates `/<dir>/Sub` through the API as the page's user. */
async function setup(page: Page, dir: string) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  for (const p of [`/${dir}`, `/${dir}/Sub`]) {
    expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: p } })).status()).toBe(201);
  }
}

test('#366 import page: Enter on a folder or a crumb focuses the current crumb', async ({ page }, info) => {
  const dir = tag(info, 'import');
  await setup(page, dir);
  await page.goto('/import');
  await expect(page.getByRole('heading', { level: 1, name: /Export-Archiv importieren|Import an export archive/ })).toBeVisible();

  const folder = page.getByRole('button', { name: dir, exact: true });
  await folder.focus();
  await page.keyboard.press('Enter');
  const current = page.locator('.picker-crumbs [aria-current="location"]');
  await expect(current).toHaveText(dir);
  await expect(current).toBeFocused();

  await page.getByRole('button', { name: 'Sub', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(current).toHaveText('Sub');
  await expect(current).toBeFocused();

  // Back up through a crumb: the crumb that had the focus is now the current one, re-rendered.
  await page.locator('.picker-crumbs button', { hasText: dir }).focus();
  await page.keyboard.press('Enter');
  await expect(current).toHaveText(dir);
  await expect(current).toBeFocused();
});

test('#366 file request dialog: opening a folder keeps the focus inside the dialog', async ({ page }, info) => {
  const dir = tag(info, 'request');
  await setup(page, dir);
  const toggle = page.getByRole('button', { name: /^(Orte|Places)$/ });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('link', { name: /^(Dateianfragen|File requests)/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Dateianfragen|File requests/ })).toBeVisible();
  await page.getByRole('button', { name: /Neue Dateianfrage|New file request/ }).click();
  const d = page.getByRole('dialog', { name: /Neue Dateianfrage|New file request/ });
  await expect(d).toBeVisible();

  await d.getByRole('button', { name: dir, exact: true }).focus();
  await page.keyboard.press('Enter');
  const current = d.locator('.picker-crumbs [aria-current="location"]');
  await expect(current).toHaveText(dir);
  await expect(current).toBeFocused();
  expect(await d.evaluate((el) => el.contains(document.activeElement))).toBe(true);
});
