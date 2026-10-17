import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

// #215: batch rename. Five photos are selected, numbered with a pattern in the dialog, the preview shows the new names
// and the job renames them; a name that is taken outside the batch blocks "Rename" until a policy is picked for it.
// Both projects share one server and one `testuser`; every folder carries the project.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const bar = (page: Page) => page.getByRole('group', { name: /^(Aktionen für die Auswahl|Actions for the selection)$/ });
// The selection bar's entry for more than one item; German puts a no-break space before the ellipsis.
const PARENT = 'zz-batch-rename-215';
const RENAME_MANY = /^(Umbenennen\s…|Rename…)$/;
const dialog = (page: Page) => page.getByRole('dialog', { name: /Elemente umbenennen|Rename \d+ items/ });

async function setup(page: Page, dir: string, names: string[]) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  // Under one parent that sorts last, so the home's root (windowed beyond 200 entries) keeps other tests' rows in place.
  expect([201, 409]).toContain((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${PARENT}` } })).status());
  dir = `${PARENT}/${dir}`;
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  for (const name of names) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(`photo ${name}`) });
    expect(r.status()).toBe(201);
  }
  await page.goto(`/home/${dir.split('/').map(encodeURIComponent).join('/')}`);
  await expect(page.locator('tbody tr')).toHaveCount(names.length);
}

// The finished rename jobs would stay in the transfer panel above every later test's folder (one shared server), and on
// a phone push its content below the fold.
test.afterEach(async ({ page }) => {
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/v1/transfers/clear', { headers })).status()).toBe(204);
});

test('select five photos, number them with a pattern and find them under their new names', async ({ page }, info) => {
  const photos = ['IMG_2041.jpg', 'IMG_2042.jpg', 'IMG_2043.jpg', 'IMG_2044.jpg', 'IMG_2045.jpg'];
  await setup(page, `batch-${tag(info)}`, photos);
  for (const p of photos) await row(page, p).getByRole('checkbox').check();
  await bar(page).getByRole('button', { name: RENAME_MANY }).click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d.getByRole('heading', { name: /5 Elemente umbenennen|Rename 5 items/ })).toBeVisible();

  await d.getByRole('checkbox', { name: /^(Nummerieren|Number the items)$/ }).check();
  await d.getByRole('textbox', { name: /^(Muster|Pattern)/ }).fill('Holiday {n:03}');
  await d.getByRole('spinbutton', { name: /^(Beginnen bei|Start at)$/ }).fill('1');
  // The preview: every old name with its new one, in the order of the list.
  const preview = d.getByRole('table', { name: /^(Vorschau|Preview)$/ });
  const expected = ['Holiday 001.jpg', 'Holiday 002.jpg', 'Holiday 003.jpg', 'Holiday 004.jpg', 'Holiday 005.jpg'];
  await expect(preview.locator('td.batch-rename-new')).toHaveText(expected);
  await expect(preview.locator('tbody tr')).toHaveCount(5);
  const submit = d.getByRole('button', { name: /^(5 Elemente umbenennen|Rename 5 items)$/ });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(d).toHaveCount(0);

  // The job runs in the transfer panel; the folder relists once it has ended.
  for (const name of expected) await expect(row(page, name)).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(5);
  for (const p of photos) await expect(row(page, p)).toHaveCount(0);
});

test('a name taken outside the batch blocks the rename until "keep both" is picked for it', async ({ page }, info) => {
  await setup(page, `batch-taken-${tag(info)}`, ['beach.jpg', 'dunes.jpg', 'Trip beach.jpg']);
  await row(page, 'beach.jpg').getByRole('checkbox').check();
  await row(page, 'dunes.jpg').getByRole('checkbox').check();
  await bar(page).getByRole('button', { name: RENAME_MANY }).click();
  const d = dialog(page);
  await d.getByRole('textbox', { name: /^(Voranstellen|Add before)$/ }).fill('Trip ');
  const preview = d.getByRole('table', { name: /^(Vorschau|Preview)$/ });
  const taken = preview.locator('tbody tr', { hasText: 'Trip beach.jpg' });
  await expect(taken).toContainText(/Ein Element mit diesem Namen gibt es hier schon|An item with this name is already here/);
  await expect(d.getByRole('status')).toHaveText(/Löse zuerst|Resolve every flagged name first/);
  const submit = d.getByRole('button', { name: /^(2 Elemente umbenennen|Rename 2 items)$/ });
  await expect(submit).toBeDisabled();

  await taken.getByRole('combobox', { name: /„beach\.jpg“|“beach\.jpg”/ }).selectOption('keep-both');
  // The member's sort decides the order of the rows; each shows the name it will get.
  for (const name of ['Trip beach (1).jpg', 'Trip dunes.jpg']) {
    await expect(preview.locator('td.batch-rename-new').getByText(name, { exact: true })).toBeVisible();
  }
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(d).toHaveCount(0);
  for (const name of ['Trip beach (1).jpg', 'Trip dunes.jpg', 'Trip beach.jpg']) await expect(row(page, name)).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(3);
});
