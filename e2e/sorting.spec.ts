import { expect, test, type Page, type TestInfo } from '@playwright/test';

// #226: sort by name, size and modified, both ways, through the column headers in the list and the sort menu in the
// gallery and on a phone. Folders come first, names compare naturally, and the choice follows the member. Both projects
// share one server and one `testuser`; every test works in its own folder and starts and ends with the default sort.

const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const mobile = (info: TestInfo) => info.project.name.startsWith('mobile');

async function headers(page: Page) {
  const me = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin };
}
async function putSort(page: Page, key: string, dir: string) {
  const r = await page.request.put('/api/v1/settings/sort', { data: { key, dir }, headers: await headers(page) });
  expect(r.status(), await r.text()).toBe(200);
}

// Sizes chosen so that size order differs from name order.
const FILES: Record<string, number> = { 'file-10.txt': 1, 'file-2.txt': 3000, '.dotfile': 20, 'Middle.txt': 500 };
const BY_NAME = ['zeta', '.dotfile', 'file-2.txt', 'file-10.txt', 'Middle.txt'];
const BY_SIZE_ASC = ['zeta', 'file-10.txt', '.dotfile', 'Middle.txt', 'file-2.txt'];
const BY_SIZE_DESC = ['zeta', 'file-2.txt', 'Middle.txt', '.dotfile', 'file-10.txt'];

/** Creates `/<dir>` with a folder and the files through the API, then opens it in list view. */
async function setup(page: Page, info: TestInfo): Promise<string> {
  const dir = `sorting-${tag(info)}`;
  const h = await headers(page);
  for (const d of [`/${dir}`, `/${dir}/zeta`]) {
    expect([201, 409]).toContain((await page.request.post('/api/v1/sources/home/mkdir', { headers: h, data: { path: d } })).status());
  }
  for (const [name, size] of Object.entries(FILES)) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=replace`,
      { headers: { ...h, 'content-type': 'application/octet-stream' }, data: Buffer.alloc(size, 0x61) });
    expect(r.status(), await r.text()).toBeLessThan(300);
  }
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(page.locator('tbody tr')).toHaveCount(BY_NAME.length);
  return dir;
}
const rowNames = (page: Page) => page.locator('tbody tr td.name');
const sortMenu = (page: Page) => page.getByRole('combobox', { name: /Sortieren nach|Sort by/ });

test.beforeEach(async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
  await putSort(page, 'name', 'asc');
});
test.afterEach(async ({ page }) => { await putSort(page, 'name', 'asc'); });

test('the list is in natural order with folders first', async ({ page }, info) => {
  await setup(page, info);
  await expect(rowNames(page)).toHaveText(BY_NAME);
});

test('column headers sort by size both ways, and the choice survives a reload', async ({ page }, info) => {
  test.skip(mobile(info), 'the phone hides the header row; it has the sort menu');
  await setup(page, info);
  await expect(sortMenu(page)).toBeHidden(); // the headers are the control here
  const size = page.getByRole('columnheader', { name: /Größe|Size/ });
  await expect(page.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
  await size.getByRole('button').click();
  await expect(size).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.getByRole('columnheader', { name: 'Name' })).not.toHaveAttribute('aria-sort', /.*/);
  await expect(rowNames(page)).toHaveText(BY_SIZE_ASC);
  await size.getByRole('button').click();
  await expect(size).toHaveAttribute('aria-sort', 'descending');
  await expect(rowNames(page)).toHaveText(BY_SIZE_DESC);
  // Stored on the server for the member: a reload keeps it.
  await page.reload();
  await expect(rowNames(page)).toHaveText(BY_SIZE_DESC);
  await page.getByRole('columnheader', { name: 'Name' }).getByRole('button').click();
  await expect(rowNames(page)).toHaveText(BY_NAME);
});

test('on a phone the sort menu sorts the list', async ({ page }, info) => {
  test.skip(!mobile(info), 'the wide list has its column headers');
  await setup(page, info);
  await expect(sortMenu(page)).toBeVisible();
  await sortMenu(page).selectOption('size-desc');
  await expect(rowNames(page)).toHaveText(BY_SIZE_DESC);
  await sortMenu(page).selectOption('name-desc');
  await expect(rowNames(page)).toHaveText(['zeta', 'Middle.txt', 'file-10.txt', 'file-2.txt', '.dotfile']);
  await page.reload();
  await expect(sortMenu(page)).toHaveValue('name-desc');
});

test('the gallery has the sort menu and shows its tiles in that order', async ({ page }, info) => {
  await setup(page, info);
  await page.getByRole('group', { name: /Ansicht|View/ }).getByRole('button', { name: /Galerie|Gallery/ }).click();
  const tiles = page.getByRole('list', { name: /Galerie|Gallery/ }).getByRole('listitem');
  await expect(tiles).toHaveText(BY_NAME);
  await expect(sortMenu(page)).toBeVisible();
  await sortMenu(page).selectOption('size-asc');
  await expect(tiles).toHaveText(BY_SIZE_ASC);
});
