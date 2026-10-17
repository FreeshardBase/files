import { expect, test, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';

// #221: "New folder" in the toolbar and on Shift+N, wherever the caller may change things (home, cloud connection,
// edit share), never in a read-only share. Both projects share one server; every test works in its own folder.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const crumbs = (page: Page) => page.getByRole('navigation', { name: /Pfad|Path/ });
const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const names = (page: Page) => page.locator('tbody tr .name').allInnerTexts();
const newFolderButton = (page: Page) => page.getByRole('button', { name: /^(Neuer Ordner|New folder)$/ });
// On the phone "New folder" is in the toolbar's Upload menu (#245).
const addMenu = (page: Page) => page.getByRole('button', { name: /^(Hochladen|Upload)$/ }).and(page.locator('[aria-haspopup="menu"]'));
async function openNewFolder(page: Page) {
  await expect(addMenu(page).or(newFolderButton(page))).toBeVisible();
  if (await addMenu(page).isVisible()) {
    await addMenu(page).click();
    await page.getByRole('menuitem', { name: /^(Neuer Ordner|New folder)$/ }).click();
  } else await newFolderButton(page).click();
}
const newFolderDialog = (page: Page) => page.getByRole('dialog', { name: /Neuer Ordner|New folder/ });
const focusedRowName = (page: Page) => page.evaluate(() => document.activeElement?.closest('tr')?.querySelector('.name')?.textContent?.trim());

async function headersOf(page: Page) {
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  return { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
}
/** Creates `/<dir>` and the given subfolders in the home through the API, then opens it in the SPA. */
async function setup(page: Page, dir: string, folders: string[] = []) {
  await page.goto('/');
  await expect(crumbs(page)).toBeVisible();
  const headers = await headersOf(page);
  for (const p of [`/${dir}`, ...folders.map((f) => `/${dir}/${f}`)]) {
    expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: p } })).status()).toBe(201);
  }
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(crumbs(page)).toContainText(dir);
}
async function create(page: Page, name: string) {
  await openNewFolder(page);
  const d = newFolderDialog(page);
  await expect(d.getByRole('textbox')).toBeFocused();
  await d.getByRole('textbox').fill(name);
  await d.getByRole('button', { name: /^(Erstellen|Create)$/ }).click();
  await expect(d).toHaveCount(0);
}

test('the toolbar creates a folder in the home; it is selected, focused and scrolled into view', async ({ page }, info) => {
  const dir = `new-folder-${tag(info)}`;
  await setup(page, dir, Array.from({ length: 40 }, (_, i) => `a${String(i).padStart(2, '0')}`));
  await expect(row(page, 'a00')).toBeVisible();
  await create(page, 'zz Neu');
  const created = row(page, 'zz Neu');
  await expect(created).toHaveAttribute('aria-selected', 'true');
  await expect(created).toBeInViewport();
  expect(await focusedRowName(page)).toBe('zz Neu');
  await expect(page.getByRole('status')).toContainText(/zz Neu/);
  const listed = await (await page.request.get(`/api/v1/sources/home/list?path=${encodeURIComponent(`/${dir}`)}`)).json();
  expect(listed.entries.find((e: { name: string }) => e.name === 'zz Neu')?.type).toBe('directory');
});

test('the name is checked; a taken name says so and keeps the dialog open; Esc creates nothing', async ({ page }, info) => {
  const dir = `new-folder-check-${tag(info)}`;
  await setup(page, dir, ['Ordner']);
  await expect(row(page, 'Ordner')).toBeVisible();
  await openNewFolder(page);
  const d = newFolderDialog(page);
  const input = d.getByRole('textbox');
  await expect(input).toBeFocused();
  await page.keyboard.press('Enter'); // empty
  await expect(d).toContainText(/darf nicht leer|can’t be empty/);
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await input.fill('a/b');
  await page.keyboard.press('Enter');
  await expect(d).toContainText(/darf nicht leer|can’t be empty/);

  await input.fill('Ordner');
  await page.keyboard.press('Enter');
  await expect(d).toContainText(/gibt es schon ein Element|already exists/);
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
  expect(await names(page)).toEqual(['Ordner']);
});

test('Shift+N opens the dialog, also in an empty folder, and is listed in the shortcut help', async ({ page }, info) => {
  const dir = `new-folder-key-${tag(info)}`;
  await setup(page, dir);
  await expect(page.getByText(/Dieser Ordner ist leer|This folder is empty/)).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Shift+N');
  const d = newFolderDialog(page);
  await expect(d.getByRole('textbox')).toBeFocused();
  await expect(d.getByRole('textbox')).toHaveValue(''); // the key itself is not typed into the field
  await page.keyboard.type('Erster');
  await page.keyboard.press('Enter');
  await expect(d).toHaveCount(0);
  await expect(row(page, 'Erster')).toHaveAttribute('aria-selected', 'true');
  expect(await focusedRowName(page)).toBe('Erster');

  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: /Tastenkürzel|Keyboard shortcuts/ });
  await expect(help.getByRole('row', { name: /(Umschalt|Shift) \+ N.*(Neuer Ordner|New folder)/ })).toBeVisible();
});

async function signedIn(browser: Browser, info: TestInfo, baseURL: string, login: string): Promise<Page> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const ctx = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
  const p = await ctx.newPage();
  await p.goto(`/auth/login?login_hint=${login}&returnTo=%2F`);
  await expect(nav(p)).toBeVisible();
  return p;
}

test('a member creates a folder in an edit share; a read-only share offers no "New folder"', async ({ page, browser, baseURL }, info) => {
  const member = await signedIn(browser, info, baseURL!, 'member'); // known to the shard once signed in
  const dir = `new-folder-share-${tag(info)}`;
  const folders = { edit: `edit-${tag(info)}`, read: `read-${tag(info)}` };
  await setup(page, dir, Object.values(folders));
  const headers = await headersOf(page);
  const { items } = await (await page.request.get('/api/v1/members')).json() as { items: { id: string; displayName: string }[] };
  const grantee = items.find((m) => m.displayName === 'Test Member')!.id;
  for (const access of ['edit', 'read'] as const) {
    const r = await page.request.post('/api/v1/shares', { headers, data: { source: 'home', path: `/${dir}/${folders[access]}`, grantee, access } });
    expect(r.status(), await r.text()).toBe(201);
  }
  const incoming = (await (await member.request.get('/api/v1/shares/incoming')).json()).items as { source: string; name: string }[];
  const shareOf = (name: string) => incoming.find((s) => s.name === name)!.source;
  const opened = { edit: shareOf(folders.edit), read: shareOf(folders.read) };
  await member.goto(`/${opened.read}`);
  await expect(member.getByText(/Dieser Ordner ist leer|This folder is empty/)).toBeVisible();
  await expect(newFolderButton(member)).toHaveCount(0);
  await expect(addMenu(member)).toHaveCount(0);
  await member.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await member.keyboard.press('Shift+N');
  await expect(newFolderDialog(member)).toHaveCount(0);

  await member.goto(`/${opened.edit}`);
  await expect(member.getByText(/Dieser Ordner ist leer|This folder is empty/)).toBeVisible();
  await create(member, 'vom Mitglied');
  await expect(row(member, 'vom Mitglied')).toHaveAttribute('aria-selected', 'true');
  const listed = await (await page.request.get(`/api/v1/sources/home/list?path=${encodeURIComponent(`/${dir}/${folders.edit}`)}`)).json();
  expect(listed.entries.map((e: { name: string; type: string }) => [e.name, e.type])).toEqual([['vom Mitglied', 'directory']]);
  await member.context().close();
});

test.describe('in a cloud connection', () => {
  test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

  test('"New folder" creates the folder in the connected Google Drive', async ({ page }, info) => {
    await page.goto('/auth/login?returnTo=%2Fconnections');
    await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
    const headers = await headersOf(page);
    for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
      expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
    }
    await page.reload();
    await page.getByRole('button', { name: /Google Drive verbinden|Connect Google Drive/ }).click();
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
    const source = decodeURIComponent(new URL(page.url()).pathname.slice(1));
    const name = `Projekt-${tag(info)}`;
    await create(page, name);
    await expect(row(page, name)).toHaveAttribute('aria-selected', 'true');
    const listed = await (await page.request.get(`/api/v1/sources/${encodeURIComponent(source)}/list?path=%2F`)).json();
    expect(listed.entries.find((e: { name: string }) => e.name === name)?.type).toBe('directory');
  });
});
