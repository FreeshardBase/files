import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openPlaces } from './places.ts';

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

  await openPlaces(page);
  await nav(page).getByRole('link', { name: /^(Zuletzt geändert|Recent)$/ }).click();
  await expect(page).toHaveURL(/\/recent$/);
  await expect(page.getByRole('heading', { name: /Zuletzt geändert|Recent/ })).toBeVisible();
  // Newest first: the upload is the top row.
  await expect(page.locator('tbody tr').first()).toContainText(name);
  await expect(row(page, name).locator('.origin')).toHaveText(new RegExp(`^(Mein Speicher|My storage) › ${dir}$`)); // #244

  // "Open folder" opens it with the file selected, as from Favourites (#235).
  await row(page, name).getByRole('link', { name: new RegExp(`(Ordner von|folder of) ${name}`) }).click();
  await expect(crumbs(page)).toContainText(dir);
  await expect(page).toHaveURL(new RegExp(`/home/${encodeURIComponent(dir)}\\?select=`));
  await expect(row(page, name)).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, name)).toBeFocused();
  expect(dialogs).toEqual([]);
});

test('#235: a name in Recent is a link: a file opens its folder with it selected, a folder opens itself', async ({ page }, info) => {
  const dir = `recent-links-${tag(info)}`;
  const name = `Bericht ${tag(info)}.txt`;
  await page.goto('/');
  await expect(crumbs(page)).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}/Unterordner` } })).status()).toBe(201);
  expect((await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=fail`,
    { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from('hallo') })).status()).toBe(201);
  // Recent lists uploads and folders made; the move puts the folder on top with a fresh time.
  expect((await page.request.post('/api/v1/sources/home/move', { headers,
    data: { from: `/${dir}/Unterordner`, to: `/${dir}/Ordner ${tag(info)}`, onCollision: 'fail' } })).status()).toBeLessThan(300);

  await page.goto('/recent');
  await row(page, name).getByRole('link', { name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/home/${encodeURIComponent(dir)}\\?select=`));
  await expect(row(page, name)).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, name)).toBeFocused();

  await page.goto('/recent');
  const folder = `Ordner ${tag(info)}`;
  await row(page, folder).getByRole('link', { name: folder, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/home/${encodeURIComponent(dir)}/${encodeURIComponent(folder)}$`));
  await expect(crumbs(page)).toContainText(folder);
});

test('an empty Recent view shows its own empty-state text, not the folder one (#127)', async ({ page }) => {
  await page.goto('/auth/login?login_hint=member&returnTo=%2Frecent');
  await expect(page).toHaveURL(/\/recent$/);
  await expect(page.getByRole('heading', { name: /Zuletzt geändert|Recent/ })).toBeVisible();
  await expect(page.getByText(/Noch nichts da\.|Nothing here yet\./)).toBeVisible();
  await expect(page.getByText(/Dieser Ordner ist leer\.|This folder is empty\./)).toHaveCount(0);
  await expect(page.locator('table')).toHaveCount(0);
  await openPlaces(page);
  await expect(nav(page).getByRole('link', { name: /^(Zuletzt geändert|Recent)$/ })).toHaveClass(/active/);
});
