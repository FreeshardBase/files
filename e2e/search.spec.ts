import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

// #145: name search from the header. Both projects share one server and one `testuser`; every test uses names unique
// to the project and test, so each query finds only its own files.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const crumbs = (page: Page) => page.getByRole('navigation', { name: /Pfad|Path/ });
const box = (page: Page) => page.getByRole('combobox', { name: /Dateien nach Namen suchen|Search files by name/ });
const results = (page: Page) => page.getByRole('listbox', { name: /Suchergebnisse|Search results/ });
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });

async function setUp(page: Page, dir: string, files: string[]) {
  await page.goto('/');
  await expect(crumbs(page)).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  for (const f of files) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${f}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from('x') });
    expect(r.status()).toBe(201);
  }
}

test('typing a name shows the file; arrows pick a result and Enter opens its folder with it selected', async ({ page }, info) => {
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  const dir = `search-${tag(info)}`;
  const first = `Quarterly ${tag(info)} a.txt`;
  const second = `Quarterly ${tag(info)} b.txt`;
  await setUp(page, dir, [first, second]);

  await box(page).fill(`quarterly ${tag(info)}`);
  const list = results(page);
  await expect(list.getByRole('group', { name: /Mein Speicher|My storage/ })).toBeVisible();
  await expect(list.getByRole('option')).toHaveCount(2);
  await expect(list.getByRole('option', { name: new RegExp(first) }).locator('.search-location'))
    .toHaveText(new RegExp(`^(Mein Speicher|My storage) › ${dir}$`)); // #244

  await box(page).press('ArrowDown');
  await box(page).press('ArrowDown');
  const active = list.getByRole('option', { name: new RegExp(second) });
  await expect(active).toHaveAttribute('aria-selected', 'true');
  await expect(box(page)).toHaveAttribute('aria-activedescendant', (await active.getAttribute('id'))!);
  await box(page).press('ArrowUp');
  await expect(list.getByRole('option', { name: new RegExp(first) })).toHaveAttribute('aria-selected', 'true');
  await box(page).press('ArrowDown');

  await box(page).press('Enter');
  await expect(crumbs(page)).toContainText(dir);
  await expect(page).toHaveURL(new RegExp(`/home/${encodeURIComponent(dir)}\\?select=`));
  await expect(results(page)).toHaveCount(0);
  await expect(row(page, second)).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, second)).toBeFocused();
  await expect(row(page, first)).toHaveAttribute('aria-selected', 'false');
  expect(dialogs).toEqual([]);
});

test('Escape closes the results; a click on a result opens its folder too', async ({ page }, info) => {
  const dir = `search-click-${tag(info)}`;
  const name = `Invoice ${tag(info)}.pdf`;
  await setUp(page, dir, [name]);
  await box(page).fill(`invoice ${tag(info)}`);
  await expect(results(page).getByRole('option')).toHaveCount(1);
  await box(page).press('Escape');
  await expect(results(page)).toHaveCount(0);
  await expect(box(page)).toHaveValue(`invoice ${tag(info)}`);
  await box(page).press('ArrowDown'); // reopens
  await results(page).getByRole('option', { name: new RegExp(name) }).click();
  await expect(crumbs(page)).toContainText(dir);
  await expect(row(page, name)).toHaveAttribute('aria-selected', 'true');
});

test('a search without matches shows its empty state', async ({ page }, info) => {
  await page.goto('/');
  await expect(crumbs(page)).toBeVisible();
  const q = `nothing-is-called-this-${tag(info)}`;
  await box(page).fill(q);
  await expect(page.getByText(new RegExp(`(Kein Name enthält „${q}“|Nothing found with “${q}” in its name)`)))
    .toBeVisible();
  await expect(results(page)).toHaveCount(0);
  await expect(box(page)).toHaveAttribute('aria-expanded', 'false');
});
