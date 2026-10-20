import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

// #224: in a long folder the selection bar stays in sight (sticky at the top on the desktop, fixed at the bottom on
// the phone, never over the last row), and an item menu near the bottom of the viewport opens upward.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const isMobile = (info: TestInfo) => info.project.name.startsWith('mobile');
const files = Array.from({ length: 40 }, (_, i) => `file-${String(i).padStart(2, '0')}.txt`);

/** Creates `/<dir>` with 40 small files through the API, then opens it in the SPA. */
async function setup(page: Page, dir: string) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  for (const name of files) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(name) });
    expect(r.status()).toBe(201);
  }
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(page.locator('tbody tr')).toHaveCount(files.length);
}
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const bar = (page: Page) => page.getByRole('group', { name: /^(Aktionen für die Auswahl|Actions for the selection)$/ });
const box = async (l: Locator) => (await l.boundingBox())!;
const viewportHeight = (page: Page) => page.evaluate(() => window.innerHeight);
const scrollToEnd = (page: Page) => page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

test('the selection bar stays in sight after selecting rows far down the list', async ({ page }, info) => {
  await setup(page, `selbar-${tag(info)}`);
  await scrollToEnd(page);
  await row(page, 'file-38.txt').getByRole('checkbox').check();
  await expect(bar(page)).toBeVisible();
  await expect(bar(page).getByRole('button', { name: /^(Umbenennen|Rename)$/ })).toBeVisible();

  const height = await viewportHeight(page);
  const b = await box(bar(page));
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.y + b.height).toBeLessThanOrEqual(height + 0.5);
  if (isMobile(info)) {
    // Fixed at the bottom of the screen ...
    expect(Math.abs(b.y + b.height - height)).toBeLessThan(1);
    // ... and the list keeps room for it, so the last row ends above the bar once scrolled to the end.
    await scrollToEnd(page);
    const last = await box(row(page, 'file-39.txt'));
    const after = await box(bar(page));
    expect(last.y + last.height).toBeLessThanOrEqual(after.y + 0.5);
  } else {
    // Sticky at the top of the viewport while the list is scrolled down.
    expect(b.y).toBeLessThan(1);
  }

  // Back at the top the bar sits in its place above the list, before the first row.
  await page.evaluate(() => window.scrollTo(0, 0));
  if (!isMobile(info)) expect((await box(bar(page))).y).toBeLessThan((await box(row(page, 'file-00.txt'))).y);
  await row(page, 'file-38.txt').getByRole('checkbox').uncheck();
  await expect(bar(page)).toHaveCount(0);
});

test('an item menu near the bottom of the viewport opens upward; one near the top opens downward', async ({ page }, info) => {
  await setup(page, `menuflip-${tag(info)}`);
  const height = await viewportHeight(page);

  await scrollToEnd(page);
  const lastRow = row(page, 'file-39.txt');
  const button = lastRow.getByRole('button', { name: /(Aktionen für|Actions for) file-39\.txt/ });
  await button.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  let m = await box(menu);
  expect(m.y).toBeGreaterThanOrEqual(0);
  expect(m.y + m.height).toBeLessThanOrEqual(height + 0.5);
  const b = await box(button);
  expect(m.y + m.height).toBeLessThanOrEqual(b.y + b.height / 2); // above its button (whose touch target overhangs)
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  await page.evaluate(() => window.scrollTo(0, 0));
  const first = row(page, 'file-00.txt').getByRole('button', { name: /(Aktionen für|Actions for) file-00\.txt/ });
  await first.click();
  await expect(menu).toBeVisible();
  m = await box(menu);
  const f = await box(first);
  expect(m.y).toBeGreaterThanOrEqual(f.y + f.height / 2); // below its button
  expect(m.y + m.height).toBeLessThanOrEqual(height + 0.5);
});

// #365: at 1280 px in German the bar wraps inside the page column instead of pushing the page into a horizontal
// scroll; the current crumb keeps an (ellipsised) title, and "In den Papierkorb" is the bar's last button.
test('#365 the German selection bar stays inside the page column at 1280 px, trash last', async ({ page }, info) => {
  test.skip(isMobile(info), 'desktop layout');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  const putLocale = async (locale: 'de-du' | null) =>
    expect((await page.request.put('/api/v1/settings', { headers, data: { locale, theme: 'system' } })).status()).toBe(200);
  const dir = `selbar365-${tag(info)}`;
  expect([201, 409]).toContain((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status());
  await putLocale('de-du');
  try {
    await page.goto('/home');
    await row(page, dir).getByRole('checkbox').check();
    await expect(bar(page)).toBeVisible();
    await expect(bar(page).getByRole('button', { name: 'Umbenennen' })).toBeVisible();

    const { scrollWidth, innerWidth } = await page.evaluate(() =>
      ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
    const column = await box(page.locator('.page').filter({ has: bar(page) }));
    const buttons = bar(page).locator('.button');
    const count = await buttons.count();
    for (let i = 0; i < count; i++) {
      const b = await box(buttons.nth(i));
      expect(b.x + b.width).toBeLessThanOrEqual(column.x + column.width + 0.5);
    }
    const current = page.getByRole('navigation', { name: 'Pfad' }).locator('a[aria-current="page"]');
    await expect(current).toHaveText('Mein Speicher');
    expect((await box(current)).width).toBeGreaterThan(0);
    await expect(buttons.last()).toHaveText('In den Papierkorb');
  } finally {
    await putLocale(null);
  }
});

// #383: in a pane of the two-pane layout the German bar does not squeeze into the room beside the title (six rows,
// the crumb cut): it wraps under the title onto rows of its own, and the title keeps its full width.
test('#383 in a pane of two the German selection bar wraps under the title, not beside it', async ({ page }, info) => {
  test.skip(isMobile(info), 'desktop layout');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  const put = async (url: string, data: object) => {
    const r = await page.request.put(url, { headers, data });
    expect(r.status(), await r.text()).toBe(200);
  };
  const dir = `selbar383-${tag(info)}`;
  for (const path of [`/${dir}`, `/${dir}/a`, `/${dir}/b`]) {
    expect([201, 409]).toContain((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path } })).status());
  }
  await put('/api/v1/settings', { locale: 'de-du', theme: 'system' });
  await put('/api/v1/settings/layout', { dualPane: true, tabs: false });
  try {
    await page.goto(`/home/${encodeURIComponent(dir)}`);
    const pane = page.getByRole('region', { name: 'Linker Bereich' });
    const paneRow = (name: string) => pane.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
    const header = pane.locator('thead');
    await expect(header).toBeVisible();
    const headerBefore = (await box(header)).y;
    await paneRow('a').getByRole('checkbox').check();
    await paneRow('b').getByRole('checkbox').check();
    const selection = pane.getByRole('group', { name: 'Aktionen für die Auswahl' });
    await expect(selection.locator('.button').last()).toHaveText('In den Papierkorb');

    // The count and the ten German buttons (~1580 px with their gaps) fill rows of the pane's full ~540 px: four at
    // most (DECISIONS.md 2026-10-20), not six squeezed beside the title.
    const tops = await selection.locator('.button').evaluateAll((els) =>
      [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))]);
    expect(tops.length).toBeLessThanOrEqual(4);
    // The bar is under the title, not beside it, and the current crumb is not cut.
    const current = pane.getByRole('navigation', { name: 'Pfad' }).locator('a[aria-current="page"]');
    await expect(current).toHaveText(dir);
    const crumb = await box(current);
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(crumb.y + crumb.height);
    // The list moves by at most the bar's own height.
    expect((await box(header)).y - headerBefore).toBeLessThanOrEqual((await box(selection)).height + 0.5);
    const { scrollWidth, clientWidth } = await current.evaluate((e) => ({ scrollWidth: e.scrollWidth, clientWidth: e.clientWidth }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  } finally {
    await put('/api/v1/settings/layout', { dualPane: false, tabs: false });
    await put('/api/v1/settings', { locale: null, theme: 'system' });
  }
});

// #403: one step clears a selection: Esc on a row, or the bar's "Clear selection" button; then Upload is back.
test('#403 Esc and the bar\'s clear button clear the selection and bring Upload back', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  const dir = `selclear403-${tag(info)}`;
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(name) });
    expect(r.status()).toBe(201);
  }
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(page.locator('tbody tr')).toHaveCount(3);
  const upload = page.getByRole('button', { name: /^(Hochladen|Upload)$/ });
  await expect(upload).toBeVisible();

  await row(page, 'b.txt').focus();
  await page.keyboard.press('ControlOrMeta+a');
  await expect(bar(page).locator('.selection-count')).toHaveText(/^3 (ausgewählt|selected)$/);
  if (!isMobile(info)) await expect(upload).toBeHidden(); // on the desktop the bar takes the toolbar's place
  await page.keyboard.press('Escape');
  await expect(bar(page)).toHaveCount(0);
  await expect(upload).toBeVisible();
  await expect(row(page, 'b.txt')).toBeFocused();

  await page.keyboard.press('ControlOrMeta+a');
  await expect(bar(page).locator('.selection-count')).toHaveText(/^3 (ausgewählt|selected)$/);
  const clear = bar(page).getByRole('button', { name: /^(Auswahl aufheben|Clear selection)$/ });
  await expect(clear).toBeVisible();
  await clear.click();
  await expect(bar(page)).toHaveCount(0);
  await expect(upload).toBeVisible();
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await expect(row(page, name).getByRole('checkbox')).not.toBeChecked();

  // The shortcuts dialog names the key.
  await row(page, 'b.txt').focus();
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: /^(Tastenkürzel|Keyboard shortcuts)$/ });
  await expect(dialog.getByRole('row', { name: /^Esc (Auswahl aufheben|Clear the selection)$/ })).toBeVisible();

  // Removed again so the home root stays within the list's window for other specs (it windows from 200 entries, #225).
  const del = await page.request.post('/api/v1/sources/home/delete', { data: { paths: [`/${dir}`] }, headers });
  expect(del.status(), await del.text()).toBe(204);
});

// #420: Esc clears a selection made with a row's or a tile's checkbox too, where the click leaves the focus; the focus
// then goes to that row or tile.
test('#420 Esc clears a selection made with the row or tile checkbox', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  const dir = `selcheck420-${tag(info)}`;
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(name) });
    expect(r.status()).toBe(201);
  }
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(page.locator('tbody tr')).toHaveCount(3);

  // The list: the click leaves the focus on the checkbox.
  const listBox = row(page, 'b.txt').getByRole('checkbox');
  await listBox.click();
  await expect(page.locator('tbody tr[aria-selected="true"]')).toHaveCount(1);
  await expect(bar(page)).toBeVisible();
  await expect(listBox).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('tbody tr[aria-selected="true"]')).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
  await expect(row(page, 'b.txt')).toBeFocused();

  // The gallery: the checkbox sits beside the tile's button, not inside it.
  const view = page.getByRole('group', { name: /Ansicht|View/ });
  await view.getByRole('button', { name: /Galerie|Gallery/ }).click();
  const gallery = page.getByRole('list', { name: /Galerie|Gallery/ });
  await expect(gallery.getByRole('listitem')).toHaveCount(3);
  const tile = gallery.getByRole('button', { name: 'c.txt', exact: true });
  if (!isMobile(info)) await tile.hover(); // on the desktop the checkbox shows on hover
  const tileBox = gallery.getByRole('checkbox', { name: /c\.txt/ });
  await tileBox.click();
  await expect(gallery.locator('li.selected')).toHaveCount(1);
  await expect(bar(page)).toBeVisible();
  await expect(tileBox).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(gallery.locator('li.selected')).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
  await expect(tile).toBeFocused();
  await view.getByRole('button', { name: /^(Liste|List)$/ }).click();
  await expect(page.locator('tbody tr')).toHaveCount(3);

  const del = await page.request.post('/api/v1/sources/home/delete', { data: { paths: [`/${dir}`] }, headers });
  expect(del.status(), await del.text()).toBe(204);
});

// #404: while a selection lasts the crumbs give way without overlapping: an earlier crumb that has to shrink is cut
// with its own ellipsis instead of running its letters through the "/", and the current one keeps at least 8rem.
test('#404 with a selection the German crumbs are cut with ellipses and never overlap', async ({ page }, info) => {
  test.skip(isMobile(info), 'desktop layout');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  const putLocale = async (locale: 'de-du' | null) =>
    expect((await page.request.put('/api/v1/settings', { headers, data: { locale, theme: 'system' } })).status()).toBe(200);
  const dir = `Projekte-404-${tag(info)}`;
  const sub = 'Steuer 2026';
  for (const path of [`/${dir}`, `/${dir}/${sub}`]) {
    expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path } })).status()).toBe(201);
  }
  const put = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${sub}/beleg.txt`)}&onCollision=fail`,
    { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from('beleg') });
  expect(put.status()).toBe(201);
  await putLocale('de-du');
  try {
    await page.goto(`/home/${encodeURIComponent(dir)}/${encodeURIComponent(sub)}`);
    await row(page, 'beleg.txt').getByRole('checkbox').check();
    await expect(bar(page).getByRole('button', { name: 'Umbenennen' })).toBeVisible();

    const crumbs = page.getByRole('navigation', { name: 'Pfad' });
    await expect(crumbs.locator('a')).toHaveText(['Mein Speicher', dir, sub]);
    const links = await crumbs.locator('a').evaluateAll((els) => els.map((e) => {
      const s = getComputedStyle(e);
      return { text: e.textContent!.trim(), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth,
        overflow: s.overflowX, textOverflow: s.textOverflow };
    }));
    // The crumbs did have to give way here (otherwise the test proves nothing) ...
    expect(links.some((l) => l.scrollWidth > l.clientWidth)).toBe(true);
    // ... and every crumb either fits or is cut with its own ellipsis.
    for (const l of links.filter((x) => x.scrollWidth > x.clientWidth)) {
      expect({ text: l.text, overflow: l.overflow, textOverflow: l.textOverflow })
        .toEqual({ text: l.text, overflow: 'hidden', textOverflow: 'ellipsis' });
    }
    // The current crumb keeps at least 8rem.
    const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    expect((await box(crumbs.locator('a[aria-current="page"]'))).width).toBeGreaterThanOrEqual(8 * rem - 0.5);
    // Neighbouring crumbs and separators never overlap.
    const boxes = await crumbs.locator(':scope > *').evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right };
    }));
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].left).toBeGreaterThanOrEqual(boxes[i - 1].right - 0.5);
  } finally {
    await putLocale(null);
    const del = await page.request.post('/api/v1/sources/home/delete', { data: { paths: [`/${dir}`] }, headers });
    expect(del.status(), await del.text()).toBe(204);
  }
});
