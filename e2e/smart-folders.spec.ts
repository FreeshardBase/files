import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openPlaces } from './places.ts';

// #214: smart folders. A search is saved as a smart folder from the header search; it appears in the sidebar below
// Favourites, its page shows the live result (a file added later appears, one renamed away disappears), and it can be
// edited, renamed and deleted. Both projects share one server and one `testuser`; every name carries the project.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const crumbs = (page: Page) => page.getByRole('navigation', { name: /Pfad|Path/ });
const box = (page: Page) => page.getByRole('combobox', { name: /Dateien nach Namen suchen|Search files by name/ });
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const rows = (page: Page) => page.getByRole('region', { name: /Mein Speicher|My storage/ }).locator('tbody tr');

test('save a search as a smart folder, see it change, edit, rename and delete it', async ({ page }, info) => {
  await page.goto('/');
  await expect(crumbs(page)).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  const dir = `smart-${tag(info)}`;
  const key = `zebra-${tag(info)}`;
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  const put = async (name: string) => expect((await page.request.put(
    `/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=fail`,
    { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from('x') })).status()).toBe(201);
  await put(`${key} notes.txt`);
  await put(`${key} photo.png`);

  // From the search: the dialog starts with the typed text as name and filter.
  await box(page).fill(key);
  await expect(page.getByRole('listbox', { name: /Suchergebnisse|Search results/ }).getByRole('option')).toHaveCount(2);
  await page.getByRole('button', { name: /^(Als intelligenten Ordner speichern|Save as smart folder)$/ }).click();
  const dialog = page.getByRole('dialog', { name: /Als intelligenten Ordner speichern|Save as smart folder/ });
  await expect(dialog.getByRole('textbox', { name: /Name des intelligenten Ordners|Name of the smart folder/ })).toHaveValue(key);
  await expect(dialog.getByRole('textbox', { name: /Name enthält|Name contains/ })).toHaveValue(key);
  await dialog.getByRole('button', { name: /^(Speichern|Save)$/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/smart\/[0-9a-f]{32}$/);
  await expect(page.getByRole('heading', { name: key, level: 1 })).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  const nav = await openPlaces(page);
  const entry = nav.getByRole('link', { name: key });
  await expect(entry).toBeVisible();
  // Below Favourites, in the same group.
  const links = await nav.getByRole('group', { name: /Sammlungen|Collections/ }).getByRole('link').allTextContents();
  expect(links.map((l) => l.trim()).indexOf(key)).toBe(links.map((l) => l.trim()).findIndex((l) => /^(Favoriten|Favourites)$/.test(l)) + 1);

  // A file added later appears and one renamed away disappears, the next time it is opened.
  await put(`${key} later.txt`);
  expect((await page.request.post('/api/v1/sources/home/move', { headers,
    data: { from: `/${dir}/${key} notes.txt`, to: `/${dir}/horse.txt`, onCollision: 'fail' } })).status()).toBe(200);
  await page.reload();
  await expect(rows(page)).toHaveCount(2);
  await expect(row(page, `${key} later.txt`)).toBeVisible();
  await expect(row(page, `${key} notes.txt`)).toHaveCount(0);

  // A result behaves like a list row: its file opens in the preview.
  await row(page, `${key} later.txt`).getByRole('link', { name: `${key} later.txt` }).click();
  const preview = page.getByRole('dialog', { name: new RegExp(`${key} later\\.txt`) });
  await expect(preview).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);

  // Edit: only images now.
  await page.getByRole('button', { name: /^(Bearbeiten|Edit)$/ }).click();
  const edit = page.getByRole('dialog', { name: new RegExp(`(„${key}“ bearbeiten|Edit “${key}”)`) });
  await edit.getByRole('checkbox', { name: /^(Bilder|Images)$/ }).check();
  await edit.getByRole('button', { name: /^(Speichern|Save)$/ }).click();
  await expect(edit).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, `${key} photo.png`)).toBeVisible();

  // Rename, then delete after the confirmation.
  await page.getByRole('button', { name: /^(Umbenennen|Rename)$/ }).click();
  const rename = page.getByRole('dialog');
  await rename.getByRole('textbox').fill(`Pictures ${tag(info)}`);
  await rename.getByRole('button', { name: /^(Umbenennen|Rename)$/ }).click();
  await expect(page.getByRole('heading', { name: `Pictures ${tag(info)}`, level: 1 })).toBeVisible();
  await expect((await openPlaces(page)).getByRole('link', { name: `Pictures ${tag(info)}` })).toBeVisible();
  await page.getByRole('button', { name: /^(Löschen|Delete)$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^(Löschen|Delete)$/ }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect((await openPlaces(page)).getByRole('link', { name: `Pictures ${tag(info)}` })).toHaveCount(0);
});
