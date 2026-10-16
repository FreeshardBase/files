import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';

// #230: rename reports its own errors inline and keeps the typed name; a double click on "Move to trash" or "Copy here"
// sends one request; an action cut off by an expired session is reported once the member is signed in again.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;

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
const status = (page: Page) => page.getByRole('status').filter({ hasText: /./ });
const renameDialog = (page: Page) => page.getByRole('dialog', { name: /Umbenennen|Rename/ });
const bar = (page: Page) => page.getByRole('group', { name: /^(Aktionen für die Auswahl|Actions for the selection)$/ });
const failures = (page: Page) => page.locator('.upload-failures');

/** Holds every matching request for a moment, so a second click lands while the first is in flight; counts them. */
async function slow(page: Page, url: string): Promise<{ count: number }> {
  const seen = { count: 0 };
  await page.route(url, async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    seen.count++;
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  return seen;
}

async function openRename(page: Page, name: string) {
  await row(page, name).focus();
  await page.keyboard.press('F2');
  await expect(renameDialog(page).getByRole('textbox')).toBeFocused();
}

test('a name over 255 bytes stays in the open dialog with a hint about the length', async ({ page }, info) => {
  const dir = `rename-long-${tag(info)}`;
  await setup(page, dir, { 'a.txt': 'A' });
  await openRename(page, 'a.txt');
  const long = 'x'.repeat(300);
  await renameDialog(page).getByRole('textbox').fill(long);
  await page.keyboard.press('Enter');
  const field = renameDialog(page).getByRole('textbox');
  await expect(field).toHaveAccessibleDescription(/zu lang: höchstens 255 Zeichen|too long: at most 255 characters/);
  await expect(field).toHaveValue(long);
  await expect(field).toBeFocused();
  await expect(page.getByText(/verschoben|moved/)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(renameDialog(page)).toHaveCount(0);
  expect(await names(page)).toEqual(['a.txt']);
});

test('a rename the server refuses keeps the dialog open with a rename message; a new name then goes through', async ({ page }, info) => {
  const dir = `rename-refused-${tag(info)}`;
  await setup(page, dir, { 'a.txt': 'A', 'b.txt': 'B' });
  await openRename(page, 'a.txt');
  const field = renameDialog(page).getByRole('textbox');
  await field.fill('b.txt');
  await page.keyboard.press('Enter');
  await expect(field).toHaveAccessibleDescription(
    /Umbenennen hat nicht geklappt: Ein Eintrag mit diesem Namen existiert bereits\.|Renaming didn't work: An item with this name already exists\./);
  await expect(field).toHaveValue('b.txt');
  await expect(field).toBeFocused();
  await expect(page.getByText(/0 von 1 verschoben|0 of 1 moved/)).toHaveCount(0);
  await expect(failures(page)).toHaveCount(0);
  // Offline: the same dialog, the same rename message.
  await page.route('**/api/v1/sources/home/move', (route) => route.abort());
  await field.fill('c.txt');
  await expect(field).not.toHaveAttribute('aria-invalid', 'true');
  await page.keyboard.press('Enter');
  await expect(field).toHaveAccessibleDescription(/Umbenennen hat nicht geklappt: Keine Verbindung zum Shard\.|Renaming didn't work: No connection to the shard\./);
  await page.unroute('**/api/v1/sources/home/move');
  await page.keyboard.press('Enter');
  await expect(renameDialog(page)).toHaveCount(0);
  await expect(status(page)).toContainText(/Umbenannt in c\.txt|Renamed to c\.txt/);
  expect(await names(page)).toEqual(['b.txt', 'c.txt']);
});

test('the rename button is disabled while the rename is in flight; a double click renames once', async ({ page }, info) => {
  const dir = `rename-twice-${tag(info)}`;
  await setup(page, dir, { 'a.txt': 'A' });
  const moves = await slow(page, '**/api/v1/sources/home/move');
  await openRename(page, 'a.txt');
  await renameDialog(page).getByRole('textbox').fill('b.txt');
  const submit = renameDialog(page).getByRole('button', { name: /^(Umbenennen|Rename)$/ });
  await submit.dblclick();
  await expect(renameDialog(page)).toHaveCount(0);
  await expect(status(page)).toContainText(/Umbenannt in b\.txt|Renamed to b\.txt/);
  expect(await names(page)).toEqual(['b.txt']);
  expect(moves.count).toBe(1);
});

test('a double click on "Move to trash" sends one request and reports no error', async ({ page }, info) => {
  const dir = `trash-twice-${tag(info)}`;
  await setup(page, dir, { 'a.txt': 'A', 'keep.txt': 'K' });
  const deletes = await slow(page, '**/api/v1/sources/home/delete');
  await row(page, 'a.txt').getByRole('checkbox').check();
  const trash = bar(page).getByRole('button', { name: /^(In den Papierkorb|Move to trash)$/ });
  await trash.dblclick();
  await expect(status(page)).toContainText(/1 in den Papierkorb verschoben|1 moved to trash/);
  await expect(row(page, 'a.txt')).toHaveCount(0);
  await page.waitForTimeout(600); // a second request would answer within this
  expect(deletes.count).toBe(1);
  await expect(failures(page)).toHaveCount(0);
  expect(await names(page)).toEqual(['keep.txt']);
});

test('"Copy here" is disabled while the copy runs; a double click copies once', async ({ page }, info) => {
  const dir = `copy-twice-${tag(info)}`;
  await setup(page, dir, { 'x.txt': 'X' }, ['Ziel']);
  await row(page, 'x.txt').getByRole('checkbox').check();
  await bar(page).getByRole('button', { name: /^(Kopieren|Copy)$/ }).click();
  await page.getByRole('button', { name: 'Ziel', exact: true }).click();
  await expect(page.getByText(/Dieser Ordner ist leer|This folder is empty/)).toBeVisible();
  const copies = await slow(page, '**/api/v1/sources/home/copy');
  const paste = bar(page).getByRole('button', { name: /^(Hierher kopieren|Copy here) \(1\)$/ });
  await paste.dblclick();
  await expect(status(page)).toContainText(/1 von 1 kopiert|1 of 1 copied/);
  await expect(paste).toBeEnabled();
  expect(copies.count).toBe(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(failures(page)).toHaveCount(0);
  expect(await names(page)).toEqual(['x.txt']);
});

test('after an expired session cut off a rename, the member is back in the folder and told it did not happen', async ({ page, context }, info) => {
  const dir = `expired-${tag(info)}`;
  await setup(page, dir, { 'a.txt': 'A' });
  await openRename(page, 'a.txt');
  await renameDialog(page).getByRole('textbox').fill('b.txt');
  await context.clearCookies({ name: 'fs_sid' }); // the session has expired
  await page.keyboard.press('Enter');
  // The single sign-on (the fake IdP approves at once) brings the member back to the same folder.
  const note = page.getByRole('alert').filter({ hasText: /Sitzung war abgelaufen|session had expired/ });
  await expect(note).toContainText(/letzte Aktion wurde nicht ausgeführt|last action was not carried out/);
  await expect(page).toHaveURL(new RegExp(`/home/${dir}$`));
  await expect(row(page, 'a.txt')).toBeVisible();
  expect(await names(page)).toEqual(['a.txt']);
  await note.getByRole('button', { name: /^(Schließen|Dismiss)$/ }).click();
  await expect(note).toHaveCount(0);
  // Said once: a reload does not repeat it.
  await page.reload();
  await expect(row(page, 'a.txt')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: /Sitzung war abgelaufen|session had expired/ })).toHaveCount(0);
});

test('an expired session met by a plain listing reports nothing after the sign-in', async ({ page, context }, info) => {
  const dir = `expired-read-${tag(info)}`;
  await setup(page, dir, { 'a.txt': 'A' });
  await context.clearCookies({ name: 'fs_sid' });
  await page.reload(); // /api/v1/me answers 401 and the shell goes through the login
  await expect(row(page, 'a.txt')).toBeVisible();
  expect((await page.request.get('/api/v1/me')).status()).toBe(200);
  await expect(page.getByRole('alert').filter({ hasText: /Sitzung war abgelaufen|session had expired/ })).toHaveCount(0);
});
