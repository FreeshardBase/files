import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

// #229: the gallery has the list's selection model and actions. Click opens, Ctrl/Shift+click and Space select, each
// tile has a checkbox (on hover or focus, always while selected or on a touch screen), long-press selects on touch, the
// context menu and the tile's menu offer the list's actions, and the selection bar acts on the selected tiles.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const mobile = (info: TestInfo) => info.project.name.startsWith('mobile');
const FILES = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];

/** Creates `/<dir>` with a sub-folder and four small files through the API, then opens it in the gallery. */
async function setup(page: Page, dir: string) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  for (const d of [`/${dir}`, `/${dir}/album`]) {
    expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: d } })).status()).toBe(201);
  }
  for (const name of FILES) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(name) });
    expect(r.status()).toBe(201);
  }
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(page.locator('tbody tr')).toHaveCount(5);
  await page.getByRole('group', { name: /Ansicht|View/ }).getByRole('button', { name: /Galerie|Gallery/ }).click();
  await expect(gallery(page).getByRole('listitem')).toHaveCount(5);
}
const gallery = (page: Page) => page.getByRole('list', { name: /Galerie|Gallery/ });
const tile = (page: Page, name: string): Locator => gallery(page).getByRole('button', { name, exact: true });
const check = (page: Page, name: string): Locator => gallery(page).getByRole('checkbox', { name: `Select ${name}` });
const bar = (page: Page) => page.getByRole('group', { name: /^(Aktionen für die Auswahl|Actions for the selection)$/ });
const MENU = ['Download', 'Share', 'Details', 'Rename', 'Move', 'Copy', 'Move to…', 'Copy to…', 'Add to favourites', 'Move to trash'];

test('gallery: click opens, Ctrl/Shift+click and Space select, hover shows the checkbox, the context menu and the bar act', async ({ page }, info) => {
  test.skip(mobile(info), 'mouse and keyboard; the phone has the touch test');
  await setup(page, `gallery-select-${tag(info)}`);
  await page.mouse.move(0, 0);

  // The checkbox shows on hover or focus only, until the tile is selected.
  await expect(check(page, 'a.txt')).toBeHidden();
  await tile(page, 'a.txt').hover();
  await expect(check(page, 'a.txt')).toBeVisible();
  await expect(check(page, 'a.txt')).not.toBeChecked();

  // Ctrl+click selects without opening; Shift+click selects the range from there.
  await tile(page, 'a.txt').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(check(page, 'a.txt')).toBeChecked();
  await expect(bar(page).getByRole('button', { name: 'Rename' })).toBeVisible();
  await tile(page, 'c.txt').click({ modifiers: ['Shift'] });
  for (const n of ['a.txt', 'b.txt', 'c.txt']) await expect(check(page, n)).toBeChecked();
  await expect(check(page, 'd.txt')).toBeHidden(); // neither selected, hovered nor focused
  await page.mouse.move(0, 0);
  await expect(check(page, 'b.txt')).toBeVisible(); // a selected tile keeps its checkbox
  // Three selected: no single rename, the batch rename instead (#215).
  await expect(bar(page).getByRole('button', { name: 'Rename', exact: true })).toHaveCount(0);
  await expect(bar(page).getByRole('button', { name: 'Rename…', exact: true })).toBeVisible();

  // Space toggles the focused tile and does not open the preview; the checkbox shows on focus.
  await tile(page, 'd.txt').focus();
  await page.mouse.move(0, 0);
  await expect(check(page, 'd.txt')).toBeVisible();
  await page.keyboard.press('Space');
  await expect(check(page, 'd.txt')).toBeChecked();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Space');
  await expect(check(page, 'd.txt')).not.toBeChecked();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The checkbox itself toggles too.
  await check(page, 'd.txt').click();
  await expect(check(page, 'd.txt')).toBeChecked();
  await check(page, 'd.txt').click();
  await expect(check(page, 'd.txt')).not.toBeChecked();

  // A plain click still opens: the file in the preview, without changing the selection.
  await tile(page, 'd.txt').click();
  await expect(page.getByRole('dialog', { name: 'd.txt', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(tile(page, 'd.txt')).toBeFocused();
  await expect(check(page, 'a.txt')).toBeChecked();

  // The context menu offers the list's actions; Rename acts on the tile itself.
  await tile(page, 'd.txt').click({ button: 'right' });
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(MENU);
  await expect(page.getByRole('menuitem').first()).toBeFocused();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename' });
  await expect(rename.getByRole('textbox')).toHaveValue('d.txt');
  await rename.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Shift+F10 opens the same menu from the keyboard; Esc closes it and the tile keeps the focus.
  await tile(page, 'b.txt').focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(MENU);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(tile(page, 'b.txt')).toBeFocused();

  // The selection bar moves the selected tiles to the trash.
  await bar(page).getByRole('button', { name: 'Move to trash' }).click();
  await expect(gallery(page).getByRole('listitem')).toHaveCount(2);
  await expect(tile(page, 'd.txt')).toBeVisible();
  await expect(tile(page, 'album')).toBeVisible();
  await expect(bar(page)).toHaveCount(0);

  // Ctrl+A selects every tile; Delete moves the selection to the trash.
  await tile(page, 'd.txt').focus();
  await page.keyboard.press('ControlOrMeta+a');
  await expect(check(page, 'album')).toBeChecked();
  await expect(check(page, 'd.txt')).toBeChecked();
  await check(page, 'album').click();
  await tile(page, 'd.txt').focus();
  await page.keyboard.press('Delete');
  await expect(gallery(page).getByRole('listitem')).toHaveCount(1);
  await expect(tile(page, 'album')).toBeVisible();
});

test('gallery on a phone: long-press selects, taps on the checkbox add to it, the tile menu has every action', async ({ page }, info) => {
  test.skip(!mobile(info), 'touch');
  await setup(page, `gallery-touch-${tag(info)}`);
  // On a touch screen (no hover) the checkbox and the menu button are always there, with 44 px targets.
  await expect(check(page, 'b.txt')).toBeVisible();
  for (const l of [check(page, 'b.txt').locator('xpath=ancestor::label'), gallery(page).getByRole('button', { name: 'Actions for b.txt' })]) {
    const b = (await l.boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(44); expect(b.height).toBeGreaterThanOrEqual(44);
  }

  // A touch held still for half a second selects the tile and opens nothing.
  const box = (await tile(page, 'b.txt').locator('.gallery-name').boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  // Held until the press has selected: on a busy renderer Chromium runs the queued touchEnd before the long-press
  // timer, so a fixed wait would release too early.
  await expect(check(page, 'b.txt')).toBeChecked();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(check(page, 'b.txt')).toBeChecked();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(bar(page).getByRole('button', { name: 'Rename' })).toBeVisible();

  // A tap on another tile's checkbox adds it; a tap on a tile still opens it.
  await check(page, 'c.txt').tap();
  await expect(check(page, 'c.txt')).toBeChecked();
  await expect(check(page, 'b.txt')).toBeChecked();
  await tile(page, 'a.txt').tap();
  await expect(page.getByRole('dialog', { name: 'a.txt', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The tile's menu button opens the list's actions; "Move" there marks the whole selection.
  await gallery(page).getByRole('button', { name: 'Actions for c.txt' }).tap();
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(MENU);
  // c.txt starts the second row of tiles: its menu hangs to the right and stays on the screen.
  const m = (await page.getByRole('menu').boundingBox())!;
  const width = await page.evaluate(() => window.innerWidth);
  expect(m.x).toBeGreaterThanOrEqual(0); expect(m.x + m.width).toBeLessThanOrEqual(width);
  await page.getByRole('menuitem', { name: 'Move', exact: true }).tap();
  await expect(page.getByRole('status')).toContainText('2 items ready to move');
});
