import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openPlaces } from './places.ts';

// Both projects share one server, one user and so one trash; every test uses names unique to the project and test.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;

async function headers(page: Page) {
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  return { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
}
/** Creates `/<dir>` with the given files through the API. */
async function setup(page: Page, dir: string, files: Record<string, string>) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const h = await headers(page);
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers: h, data: { path: `/${dir}` } })).status()).toBe(201);
  for (const [name, text] of Object.entries(files)) await putFile(page, `/${dir}/${name}`, text);
}
async function putFile(page: Page, path: string, text: string) {
  const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=fail`,
    { headers: { ...await headers(page), 'content-type': 'application/octet-stream' }, data: Buffer.from(text) });
  expect(r.status()).toBe(201);
}
async function trashByApi(page: Page, ...paths: string[]) {
  expect((await page.request.post('/api/v1/sources/home/delete', { headers: await headers(page), data: { paths } })).status()).toBe(204);
}
const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
async function openTrash(page: Page) {
  await openPlaces(page);
  await nav(page).getByRole('link', { name: /Papierkorb|Trash/ }).click();
  await expect(page.getByRole('heading', { name: /Papierkorb|Trash/ })).toBeVisible();
}
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const status = (page: Page) => page.getByRole('status');
const contentOf = async (page: Page, path: string) =>
  (await page.request.get(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}`)).text();

test('delete a file, restore it from the trash, and find it back in its folder', async ({ page }, info) => {
  const dir = `trash-restore-${tag(info)}`;
  const name = `Bericht ${tag(info)}.txt`;
  await setup(page, dir, { [name]: 'inhalt', 'bleibt.txt': 'x' });
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await row(page, name).getByRole('button', { name: /Aktionen für|Actions for/ }).click();
  await page.getByRole('menuitem', { name: /In den Papierkorb|Move to trash/ }).click();
  await expect(row(page, name)).toHaveCount(0);

  await openTrash(page);
  await expect(row(page, name)).toBeVisible();
  await expect(row(page, name).locator('.origin')).toHaveText(`/${dir}`);
  await row(page, name).getByRole('button', { name: /wiederherstellen|Restore/ }).click();
  await expect(status(page)).toContainText(name);
  await expect(status(page)).toContainText(`/${dir}`);
  await expect(row(page, name)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Papierkorb|Trash/ })).toBeFocused();

  await status(page).getByRole('link', { name: /Ordner öffnen|Open folder/ }).click();
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toContainText(dir);
  await expect(row(page, name)).toBeVisible();
  expect(await contentOf(page, `/${dir}/${name}`)).toBe('inhalt');
});

test('restoring onto a taken name opens the collision dialog; Esc skips, "keep both" keeps both', async ({ page }, info) => {
  const dir = `trash-collide-${tag(info)}`;
  const name = `a-${tag(info)}.txt`;
  await setup(page, dir, { [name]: 'old' });
  await trashByApi(page, `/${dir}/${name}`);
  await putFile(page, `/${dir}/${name}`, 'new');
  await openTrash(page);

  const restoreButton = row(page, name).getByRole('button', { name: /wiederherstellen|Restore/ });
  const dialog = page.getByRole('dialog', { name: /schon vergeben|bereits vergeben|already taken/ });
  await restoreButton.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(name);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(status(page)).toContainText(/nicht wiederhergestellt|not restored/);
  await expect(row(page, name)).toBeVisible();
  expect(await contentOf(page, `/${dir}/${name}`)).toBe('new');

  await restoreButton.click();
  await dialog.getByRole('button', { name: /Beide behalten|Keep both/ }).click();
  await expect(row(page, name)).toHaveCount(0);
  const kept = name.replace('.txt', ' (1).txt');
  await expect(status(page)).toContainText(kept);
  expect(await contentOf(page, `/${dir}/${name}`)).toBe('new');
  expect(await contentOf(page, `/${dir}/${kept}`)).toBe('old');
});

test('delete permanently asks first; Cancel keeps the item, confirming removes it', async ({ page }, info) => {
  const dir = `trash-purge-${tag(info)}`;
  const name = `weg-${tag(info)}.txt`;
  await setup(page, dir, { [name]: 'bye' });
  await trashByApi(page, `/${dir}/${name}`);
  await openTrash(page);
  const dialog = page.getByRole('dialog', { name: /Endgültig löschen|Delete permanently/ });
  await row(page, name).getByRole('button', { name: /endgültig löschen|permanently/ }).click();
  await expect(dialog.getByRole('button', { name: /Abbrechen|Cancel/ })).toBeFocused();
  await dialog.getByRole('button', { name: /Abbrechen|Cancel/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, name)).toBeVisible();

  await row(page, name).getByRole('button', { name: /endgültig löschen|permanently/ }).click();
  await dialog.getByRole('button', { name: /Endgültig löschen|Delete permanently/ }).click();
  await expect(row(page, name)).toHaveCount(0);
  await expect(status(page)).toContainText(/endgültig gelöscht|deleted permanently/);
});

test('empty trash asks for confirmation in a dialog and the list is empty afterwards', async ({ page }, info) => {
  const dir = `trash-empty-${tag(info)}`;
  await setup(page, dir, { 'eins.txt': '1', 'zwei.txt': '2' });
  await trashByApi(page, `/${dir}/eins.txt`, `/${dir}/zwei.txt`);
  await openTrash(page);
  await expect(page.locator('tbody tr')).not.toHaveCount(0);

  const emptyButton = page.getByRole('button', { name: /^(Papierkorb leeren|Empty trash)$/ });
  const dialog = page.getByRole('dialog', { name: /Papierkorb leeren\?|Empty trash\?/ });
  await emptyButton.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(emptyButton).toBeFocused();
  await expect(page.locator('tbody tr')).not.toHaveCount(0);

  await emptyButton.click();
  await dialog.getByRole('button', { name: /Papierkorb leeren|Empty trash/ }).click();
  await expect(page.getByText(/Der Papierkorb ist leer\.|The trash is empty\./)).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await expect(emptyButton).toBeDisabled();
  const list = await (await page.request.get('/api/v1/trash')).json();
  expect(list.items).toEqual([]);
});
