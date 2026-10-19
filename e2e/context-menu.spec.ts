import { expect, test, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';

// #340: the context menu of the empty area (New folder, Upload, Paste), selection-aware row menus, the keyboard
// (Shift+F10 / ContextMenu) and long-press robustness. Both projects share one server; every test works in its own folder.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const mobile = (info: TestInfo) => info.project.name.startsWith('mobile');
const crumbs = (page: Page) => page.getByRole('navigation', { name: /Pfad|Path/ });
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const content = (page: Page) => page.locator('.folder-content');
const menu = (page: Page) => page.getByRole('menu');
const AREA = ['New folder', 'Upload files', 'Upload folder'];

async function headers(page: Page) {
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
}
/** Creates `/<dir>` with the given files through the API, then opens it in the SPA. */
async function setup(page: Page, dir: string, files: string[]) {
  await page.goto('/');
  await expect(crumbs(page)).toBeVisible();
  const h = await headers(page);
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers: h, data: { path: `/${dir}` } })).status()).toBe(201);
  for (const name of files) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=fail`,
      { headers: { ...h, 'content-type': 'application/octet-stream' }, data: Buffer.from(name) });
    expect(r.status()).toBe(201);
  }
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(page.locator('tbody tr')).toHaveCount(files.length);
}
/** A point in the empty space under the list, inside the folder's content. */
async function emptyPoint(page: Page) {
  const b = (await content(page).boundingBox())!;
  const last = (await page.locator('tbody tr').last().boundingBox())!;
  expect(b.y + b.height - (last.y + last.height)).toBeGreaterThan(40); // there is empty space under the rows
  return { x: b.x + 20, y: b.y + b.height - 15 };
}
/** Records whether the last context menu event was taken by the app (prevented) or left to the browser. */
async function watchContextMenu(page: Page) {
  await page.evaluate(() => {
    window.addEventListener('contextmenu', (e) => { (window as unknown as { prevented: boolean }).prevented = e.defaultPrevented; });
  });
}
const prevented = (page: Page) => page.evaluate(() => (window as unknown as { prevented?: boolean }).prevented);
async function touchHold(page: Page, point: { x: number; y: number }, until: () => Promise<void>) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await until();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('right-click on the empty area offers New folder and Upload, and Paste once items are marked', async ({ page }, info) => {
  test.skip(mobile(info), 'mouse');
  const dir = `area-menu-${tag(info)}`;
  await setup(page, dir, ['a.txt', 'b.txt']);
  await watchContextMenu(page);
  const at = await emptyPoint(page);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect(menu(page)).toHaveAccessibleName(`Actions in ${dir}`);
  await expect(menu(page).getByRole('menuitem')).toHaveText(AREA);
  await expect(menu(page).getByRole('menuitem').first()).toBeFocused();
  expect(await prevented(page)).toBe(true);
  // The menu opens where the pointer is.
  const m = (await menu(page).boundingBox())!;
  expect(Math.abs(m.x - at.x)).toBeLessThan(30);

  await menu(page).getByRole('menuitem', { name: 'New folder' }).click();
  const dialog = page.getByRole('dialog', { name: /New folder/ });
  await dialog.getByRole('textbox').fill('Made here');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(row(page, 'Made here')).toBeVisible();

  // "Upload files" opens the toolbar's file picker.
  await page.mouse.click(at.x, (await emptyPoint(page)).y, { button: 'right' });
  const chooser = page.waitForEvent('filechooser');
  await menu(page).getByRole('menuitem', { name: 'Upload files' }).click();
  expect((await chooser).isMultiple()).toBe(true);

  // A marked item adds Paste to the menu; choosing it moves the item here.
  await row(page, 'a.txt').focus();
  await page.keyboard.press('ControlOrMeta+x');
  await row(page, 'Made here').locator('.name button').click();
  await expect(crumbs(page)).toContainText('Made here');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  const b = (await content(page).boundingBox())!;
  await page.mouse.click(b.x + 20, b.y + b.height - 15, { button: 'right' });
  await expect(menu(page).getByRole('menuitem')).toHaveText([...AREA, 'Move here (1)']);
  await menu(page).getByRole('menuitem', { name: 'Move here (1)' }).click();
  await expect(row(page, 'a.txt')).toBeVisible();
});

test('phone: a long-press on the empty area opens the same menu', async ({ page }, info) => {
  test.skip(!mobile(info), 'touch');
  await setup(page, `area-touch-${tag(info)}`, ['a.txt']);
  await touchHold(page, await emptyPoint(page), () => expect(menu(page)).toBeVisible());
  await expect(menu(page).getByRole('menuitem')).toHaveText(AREA);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await menu(page).getByRole('menuitem', { name: 'New folder' }).tap();
  await expect(page.getByRole('dialog', { name: /New folder/ })).toBeVisible();
});

async function signedIn(browser: Browser, info: TestInfo, baseURL: string, login: string): Promise<Page> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const ctx = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
  const p = await ctx.newPage();
  await p.goto(`/auth/login?login_hint=${login}&returnTo=${encodeURIComponent('/shared')}`);
  await expect(p.getByRole('navigation', { name: /Orte|Places/ })).toBeVisible();
  return p;
}

test('a read-only share has no menu for the empty area: the browser keeps its own', async ({ page, browser, baseURL }, info) => {
  test.skip(mobile(info), 'mouse');
  const dir = `area-read-${tag(info)}`;
  await setup(page, dir, ['a.txt']);
  const member = await signedIn(browser, info, baseURL!, 'member'); // a member is listed once signed in
  const members = await (await page.request.get('/api/v1/members')).json() as { items: { id: string; displayName: string }[] };
  const grantee = members.items.find((m) => m.displayName === 'Test Member')!.id;
  const r = await page.request.post('/api/v1/shares', { data: { source: 'home', path: `/${dir}`, grantee, access: 'read' }, headers: await headers(page) });
  expect(r.status(), await r.text()).toBeLessThan(300);
  const incoming = await (await member.request.get('/api/v1/shares/incoming')).json() as { items: { name: string; source: string }[] };
  await member.goto(`/${incoming.items.find((s) => s.name === dir)!.source}`);
  await expect(row(member, 'a.txt')).toBeVisible();
  await watchContextMenu(member);
  const at = await emptyPoint(member);
  await member.mouse.click(at.x, at.y, { button: 'right' });
  expect(await prevented(member)).toBe(false);
  await expect(menu(member)).toHaveCount(0);
  // The rows keep their menu.
  await row(member, 'a.txt').locator('td.size').click({ button: 'right' });
  await expect(menu(member).getByRole('menuitem').first()).toHaveText('Download');
  await member.context().close();
});

test('the row menu acts on the selection it is part of; right-clicking another row selects only that', async ({ page }, info) => {
  test.skip(mobile(info), 'mouse');
  await setup(page, `area-select-${tag(info)}`, ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
  const check = (name: string) => row(page, name).locator('input[type=checkbox]');
  // A right-click on an unselected row selects only it.
  await check('a.txt').check();
  await row(page, 'd.txt').locator('td.size').click({ button: 'right' });
  await expect(check('d.txt')).toBeChecked();
  await expect(check('a.txt')).not.toBeChecked();
  await expect(menu(page).getByRole('menuitem', { name: 'Rename' })).toBeVisible();
  await page.keyboard.press('Escape');

  for (const n of ['a.txt', 'b.txt', 'c.txt']) await check(n).check();
  await check('d.txt').uncheck();
  await row(page, 'b.txt').locator('td.size').click({ button: 'right' });
  await expect(menu(page)).toHaveAccessibleName('3 items');
  await expect(menu(page)).toContainText('3 items');
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Download', 'Move', 'Copy', 'Move to…', 'Copy to…', 'Move to trash']);
  for (const n of ['a.txt', 'b.txt', 'c.txt']) await expect(check(n)).toBeChecked(); // the selection stays
  await menu(page).getByRole('menuitem', { name: 'Move to trash' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(row(page, 'd.txt')).toBeVisible();
});

test('Shift+F10 opens the focused row\'s menu, or the empty area\'s; the search field keeps the browser\'s menu', async ({ page }, info) => {
  test.skip(mobile(info), 'keyboard');
  const dir = `area-keys-${tag(info)}`;
  await setup(page, dir, ['a.txt', 'b.txt']);
  await row(page, 'b.txt').focus();
  await page.keyboard.press('Shift+F10');
  await expect(row(page, 'b.txt').getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row(page, 'b.txt')).toBeFocused();

  // No row focused: the empty area's menu; Esc puts the focus back on the folder's content.
  await content(page).focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu(page)).toHaveAccessibleName(`Actions in ${dir}`);
  await expect(menu(page).getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(content(page)).toBeFocused();
  await page.keyboard.press('ContextMenu');
  await expect(menu(page).getByRole('menuitem')).toHaveText(AREA);
  await page.keyboard.press('Escape');

  await watchContextMenu(page);
  const search = page.getByRole('combobox', { name: /Search files by name/ });
  await search.click({ button: 'right' });
  expect(await prevented(page)).toBe(false);
  await expect(menu(page)).toHaveCount(0);
});

test('phone: a scroll gesture starting on a row opens no menu; the row takes no text selection', async ({ page }, info) => {
  test.skip(!mobile(info), 'touch');
  await setup(page, `area-scroll-${tag(info)}`, ['a.txt', 'b.txt']);
  const r = row(page, 'a.txt');
  await expect(r).toHaveCSS('user-select', 'none');
  const box = (await r.locator('td.size').boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x, y: start.y - i * 8 }] });
  }
  await page.waitForTimeout(800); // longer than a long-press, held after the movement
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(menu(page)).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');

  // A long-press held still opens the row's menu and selects only that row.
  await touchHold(page, start, () => expect(r.getByRole('menu')).toBeVisible());
  await expect(r.locator('input[type=checkbox]')).toBeChecked();
});
