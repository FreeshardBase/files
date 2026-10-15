import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

// #141: the Recent view. Both projects share one server and one `testuser`; every test uses names unique to the
// project and test. The empty state needs a member who never wrote anything, which is `member`.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const crumbs = (page: Page) => page.getByRole('navigation', { name: /Pfad|Path/ });
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });

test('upload a file, find it in Recent, and open its folder from there', async ({ page }, info) => {
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  const dir = `recent-${tag(info)}`;
  const name = `Notiz ${tag(info)}.txt`;
  await page.goto('/');
  await expect(crumbs(page)).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  expect((await page.request.post('/api/v1/sources/home/mkdir',
    { headers: { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin }, data: { path: `/${dir}` } })).status()).toBe(201);
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(crumbs(page)).toContainText(dir);
  await page.getByTestId('upload-input').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('hallo') });
  await expect(page.getByRole('status').first()).toContainText(/1 von 1|1 of 1/);

  await nav(page).getByRole('link', { name: /^(Zuletzt|Recent)$/ }).click();
  await expect(page).toHaveURL(/\/recent$/);
  await expect(page.getByRole('heading', { name: /Zuletzt geändert|Recent/ })).toBeVisible();
  // Newest first: the upload is the top row.
  await expect(page.locator('tbody tr').first()).toContainText(name);
  await expect(row(page, name).locator('.origin')).toHaveText(`/${dir}`);

  await row(page, name).getByRole('link', { name: new RegExp(`(Ordner von|folder of) ${name}`) }).click();
  await expect(crumbs(page)).toContainText(dir);
  await expect(page).toHaveURL(new RegExp(`/home/${encodeURIComponent(dir)}$`));
  await expect(row(page, name)).toBeVisible();
  expect(dialogs).toEqual([]);
});

test('an empty Recent view shows its own empty-state text, not the folder one (#127)', async ({ page }) => {
  await page.goto('/auth/login?login_hint=member&returnTo=%2Frecent');
  await expect(page).toHaveURL(/\/recent$/);
  await expect(page.getByRole('heading', { name: /Zuletzt geändert|Recent/ })).toBeVisible();
  await expect(page.getByText(/Noch nichts da\.|Nothing here yet\./)).toBeVisible();
  await expect(page.getByText(/Dieser Ordner ist leer\.|This folder is empty\./)).toHaveCount(0);
  await expect(page.locator('table')).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: /^(Zuletzt|Recent)$/ })).toHaveClass(/active/);
});
