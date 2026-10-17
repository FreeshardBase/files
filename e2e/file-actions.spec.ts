import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Both projects share one server and data dir; every test works in its own folder named after the project and test.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const isMobile = (info: TestInfo) => info.project.name.startsWith('mobile');

/** Creates `/<dir>` with the given folders and files through the API, then opens it in the SPA. */
async function setup(page: Page, dir: string, files: Record<string, string> = {}, folders: string[] = []) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  for (const p of [`/${dir}`, ...folders.map((f) => `/${dir}/${f}`)]) {
    expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: p } })).status()).toBe(201);
  }
  for (const [name, text] of Object.entries(files)) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(text) });
    expect(r.status()).toBe(201);
  }
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(page.locator('tbody tr').first()).toBeVisible();
}
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const names = (page: Page) => page.locator('tbody tr .name').allInnerTexts();
const status = (page: Page) => page.getByRole('status');
const collision = (page: Page) => page.getByRole('dialog', { name: /schon vergeben|bereits vergeben|already taken/ });
const renameDialog = (page: Page) => page.getByRole('dialog', { name: /Umbenennen|Rename/ });
const menuFor = async (page: Page, name: string) => {
  await row(page, name).getByRole('button', { name: new RegExp(`(Aktionen für|Actions for) ${name.replace(/[.()]/g, '\\$&')}`) }).click();
  return page.getByRole('menu');
};
const focusedRowName = (page: Page) => page.evaluate(() => document.activeElement?.closest('tr')?.querySelector('.name')?.textContent?.trim());
// A click on the name opens the preview; its Download button downloads, Esc closes it again.
async function download(page: Page, name: string): Promise<string> {
  await page.getByRole('link', { name, exact: true }).click();
  const preview = page.getByRole('dialog', { name, exact: true });
  const [d] = await Promise.all([page.waitForEvent('download'), preview.getByRole('link', { name: /^(Herunterladen|Download)$/ }).click()]);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  return readFileSync(await d.path()).toString();
}
async function openFolder(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toContainText(name);
}

test('F2 renames the focused row; the stem is preselected and the bytes stay', async ({ page }, info) => {
  const dir = `rename-f2-${tag(info)}`;
  await setup(page, dir, { 'Bericht 2026.txt': 'inhalt' });
  await row(page, 'Bericht 2026.txt').focus();
  await page.keyboard.press('F2');
  const input = renameDialog(page).getByRole('textbox');
  await expect(input).toBeFocused();
  expect(await input.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe('Bericht 2026');
  await page.keyboard.type('Prüfung #1 & 50%');
  await page.keyboard.press('Enter');
  await expect(renameDialog(page)).toHaveCount(0);
  await expect(status(page)).toContainText(/Umbenannt in „Prüfung #1 & 50%\.txt“|Renamed to “Prüfung #1 & 50%\.txt”/);
  expect(await names(page)).toEqual(['Prüfung #1 & 50%.txt']);
  expect(await focusedRowName(page)).toBe('Prüfung #1 & 50%.txt');
  expect(await download(page, 'Prüfung #1 & 50%.txt')).toBe('inhalt');
});

test('rename through the item menu; Esc cancels without a change', async ({ page }, info) => {
  const dir = `rename-menu-${tag(info)}`;
  await setup(page, dir, { 'a.txt': 'a' }, ['Ordner']);
  await (await menuFor(page, 'Ordner')).getByRole('menuitem', { name: /Umbenennen|Rename/ }).click();
  await expect(renameDialog(page).getByRole('textbox')).toHaveValue('Ordner');
  await page.keyboard.press('Escape');
  await expect(renameDialog(page)).toHaveCount(0);
  expect(await names(page)).toEqual(['Ordner', 'a.txt']);

  await (await menuFor(page, 'a.txt')).getByRole('menuitem', { name: /Umbenennen|Rename/ }).click();
  await renameDialog(page).getByRole('textbox').fill('b.txt');
  await renameDialog(page).getByRole('button', { name: /^(Umbenennen|Rename)$/ }).click();
  await expect(row(page, 'b.txt')).toBeVisible();
  expect(await names(page)).toEqual(['Ordner', 'b.txt']);
});

test('renaming onto a taken name says so in the open dialog; Esc keeps both files as they were (#230)', async ({ page }, info) => {
  const dir = `rename-taken-${tag(info)}`;
  await setup(page, dir, { 'a.txt': 'A', 'b.txt': 'B' });
  await row(page, 'a.txt').focus();
  await page.keyboard.press('F2');
  await renameDialog(page).getByRole('textbox').fill('b.txt');
  await page.keyboard.press('Enter');
  await expect(renameDialog(page).getByRole('textbox')).toHaveAccessibleDescription(/gibt es schon ein Element|already exists/);
  await expect(collision(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(renameDialog(page)).toHaveCount(0);
  expect(await download(page, 'a.txt')).toBe('A');
  expect(await download(page, 'b.txt')).toBe('B');
});

test('drag and drop onto a folder moves the item into it', async ({ page }, info) => {
  test.skip(isMobile(info), 'touch has no HTML5 drag and drop; the action menu test covers moving on mobile');
  const dir = `dnd-${tag(info)}`;
  await setup(page, dir, { 'move me.txt': 'moved' }, ['Ziel']);
  await row(page, 'move me.txt').locator('td.size').dragTo(row(page, 'Ziel'));
  await expect(row(page, 'move me.txt')).toHaveCount(0);
  await expect(status(page)).toContainText(/1 von 1 verschoben|1 of 1 moved/);
  await openFolder(page, 'Ziel');
  expect(await download(page, 'move me.txt')).toBe('moved');
});

test('drag and drop of a multi-selection onto a breadcrumb moves both up', async ({ page }, info) => {
  test.skip(isMobile(info), 'touch has no HTML5 drag and drop; the action menu test covers moving on mobile');
  const dir = `dnd-crumb-${tag(info)}`;
  await setup(page, dir, {}, ['sub']);
  await openFolder(page, 'sub');
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  for (const n of ['one.txt', 'two.txt']) {
    await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/sub/${n}`)}&onCollision=fail`,
      { headers: { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin, 'content-type': 'application/octet-stream' }, data: Buffer.from(n) });
  }
  await page.reload();
  await row(page, 'one.txt').getByRole('checkbox').check();
  await row(page, 'two.txt').getByRole('checkbox').check();
  await row(page, 'one.txt').locator('td.size').dragTo(page.getByRole('navigation', { name: /Pfad|Path/ }).getByRole('link', { name: dir }));
  await expect(status(page)).toContainText(/2 von 2 verschoben|2 of 2 moved/);
  await expect(page.getByText(/Dieser Ordner ist leer|This folder is empty/)).toBeVisible();
  await page.getByRole('navigation', { name: /Pfad|Path/ }).getByRole('link', { name: dir }).click();
  await expect(row(page, 'one.txt')).toBeVisible();
  expect(await names(page)).toEqual(['sub', 'one.txt', 'two.txt']);
});

test('copy and paste with the keyboard; pasting onto the same name asks, keep both adds "(1)"', async ({ page }, info) => {
  const dir = `copy-${tag(info)}`;
  await setup(page, dir, { 'x.txt': 'copy me' }, ['Ziel']);
  await row(page, 'x.txt').focus();
  await page.keyboard.press('ControlOrMeta+c');
  await expect(status(page)).toContainText(/Ein Element zum Kopieren vorgemerkt|One item ready to copy/);
  // Same folder: the name is taken.
  await page.keyboard.press('ControlOrMeta+v');
  await expect(collision(page)).toContainText('x.txt');
  await collision(page).getByRole('button', { name: /^(Beide behalten|Keep both)$/ }).click();
  await expect(status(page)).toContainText(/1 von 1 kopiert|1 of 1 copied/);
  expect(await names(page)).toEqual(['Ziel', 'x (1).txt', 'x.txt']);
  expect(await download(page, 'x (1).txt')).toBe('copy me');
  // Another folder, through the paste button (an empty folder has no row to press Ctrl+V on).
  await openFolder(page, 'Ziel');
  await page.getByRole('button', { name: /Hierher kopieren \(1\)|Copy here \(1\)/ }).click();
  await expect(status(page)).toContainText(/1 von 1 kopiert|1 of 1 copied/);
  expect(await download(page, 'x.txt')).toBe('copy me');
});

test('Delete moves the focused row to the trash and keeps the focus in the list', async ({ page }, info) => {
  const dir = `delete-${tag(info)}`;
  await setup(page, dir, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
  await row(page, 'b.txt').focus();
  await page.keyboard.press('Delete');
  await expect(status(page)).toContainText(/Ein Element in den Papierkorb verschoben|One item moved to the trash/);
  expect(await names(page)).toEqual(['a.txt', 'c.txt']);
  expect(await focusedRowName(page)).toBeTruthy();
  // Multi-select with Space, then Delete removes the whole selection in one go.
  await row(page, 'a.txt').focus();
  await page.keyboard.press(' ');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press(' ');
  await page.keyboard.press('Delete');
  await expect(status(page)).toContainText(/2 Elemente in den Papierkorb verschoben|2 items moved to the trash/);
  await expect(page.getByText(/Dieser Ordner ist leer|This folder is empty/)).toBeVisible();
});

test('keyboard only: select, cut, open the folder, paste; the row menu opens with Shift+F10', async ({ page }, info) => {
  const dir = `kbd-${tag(info)}`;
  await setup(page, dir, { 'k.txt': 'keys' }, ['Ziel']);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  let presses = 0;
  while (await page.evaluate(() => document.activeElement?.getAttribute('role')) !== 'row' && presses++ < 30) await page.keyboard.press('Tab');
  expect(await focusedRowName(page)).toBe('Ziel');
  await page.keyboard.press('ArrowDown');
  expect(await focusedRowName(page)).toBe('k.txt');

  // The row menu: arrows move, Esc closes back onto the row.
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: /^(Verschieben|Move)$/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  expect(await focusedRowName(page)).toBe('k.txt');

  await page.keyboard.press('ControlOrMeta+x');
  await expect(status(page)).toContainText(/Ein Element zum Verschieben vorgemerkt|One item ready to move/);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toContainText('Ziel');
  const paste = page.getByRole('button', { name: /Hierher verschieben \(1\)|Move here \(1\)/ });
  for (let i = 0; i < 30 && !(await paste.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(paste).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(status(page)).toContainText(/1 von 1 verschoben|1 of 1 moved/);
  await expect(row(page, 'k.txt')).toBeVisible();
  await expect(paste).toHaveCount(0);
});

test('every action is reachable through the item action menu (mobile path)', async ({ page }, info) => {
  const dir = `menu-${tag(info)}`;
  await setup(page, dir, { 'm.txt': 'menu' }, ['Ziel']);
  // Copy into Ziel.
  await (await menuFor(page, 'm.txt')).getByRole('menuitem', { name: /^(Kopieren|Copy)$/ }).click();
  await openFolder(page, 'Ziel');
  await page.getByRole('button', { name: /Hierher kopieren \(1\)|Copy here \(1\)/ }).click();
  await expect(row(page, 'm.txt')).toBeVisible();
  await page.getByRole('button', { name: /Verschieben oder Kopieren abbrechen|Cancel moving or copying/ }).click();
  // Move the copy back up: the name is taken there, so the collision dialog asks; replace sends the old one to the trash.
  await (await menuFor(page, 'm.txt')).getByRole('menuitem', { name: /^(Verschieben|Move)$/ }).click();
  await page.getByRole('navigation', { name: /Pfad|Path/ }).getByRole('link', { name: dir }).click();
  await page.getByRole('button', { name: /Hierher verschieben \(1\)|Move here \(1\)/ }).click();
  await expect(collision(page)).toContainText('m.txt');
  await collision(page).getByRole('button', { name: /^(Ersetzen|Replace)$/ }).click();
  await expect(status(page)).toContainText(/1 von 1 verschoben|1 of 1 moved/);
  // Delete.
  await (await menuFor(page, 'm.txt')).getByRole('menuitem', { name: /In den Papierkorb|Move to trash/ }).click();
  await expect(status(page)).toContainText(/Ein Element in den Papierkorb verschoben|One item moved to the trash/);
  expect(await names(page)).toEqual(['Ziel']);
  await openFolder(page, 'Ziel');
  await expect(page.getByText(/Dieser Ordner ist leer|This folder is empty/)).toBeVisible();
});
