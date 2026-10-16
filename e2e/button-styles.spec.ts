import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openPlaces } from './places.ts';

// #238: button styles and hierarchy. A link styled as a button looks like one in every list (B1); buttons and list
// rows answer hover and press (B2); the button ring shows for the keyboard only (B3); dialogs put the forward action
// last, on the right (B4–B6); plain links are teal (B7); revoking an app password is a danger button (B8); buttons and
// fields share one 36 px height (B9). Each check runs on desktop and phone (the two projects) and in both themes;
// colours are compared with the theme's own tokens, resolved in the page.

const SCHEMES = ['light', 'dark'] as const;
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const mobile = (info: TestInfo) => info.project.name.startsWith('mobile');
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const menuButton = (page: Page, name: string) => row(page, name).getByRole('button', { name: /^(Actions for|Aktionen für) / });

async function headers(page: Page) {
  const me = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin };
}
async function mkdir(page: Page, path: string) {
  const r = await page.request.post('/api/v1/sources/home/mkdir', { data: { path }, headers: await headers(page) });
  expect([201, 409]).toContain(r.status());
}
async function putFile(page: Page, path: string, text: string) {
  const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=replace`, {
    data: Buffer.from(text), headers: { ...await headers(page), 'content-type': 'application/octet-stream' } });
  expect(r.status(), await r.text()).toBeLessThan(300);
}
async function folderWithFile(page: Page, info: TestInfo, prefix: string, scheme: string): Promise<string> {
  const dir = `/${prefix}-${scheme}-${tag(info)}`;
  await mkdir(page, dir);
  await putFile(page, `${dir}/ledger.csv`, 'a,b\n');
  return dir;
}
async function openFolder(page: Page, dir: string) {
  await page.goto(`/home${dir}`);
  await expect(row(page, 'ledger.csv')).toBeVisible();
}

/** A CSS colour expression (`var(--data)`, `color-mix(…)`) as the page computes it in the current theme. */
async function resolved(page: Page, css: string): Promise<string> {
  return page.evaluate((value) => {
    const probe = document.createElement('div');
    probe.style.color = value;
    document.body.append(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, css);
}
const style = (l: Locator, prop: string) => l.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
/** Colours of a button change with a short transition (after a theme switch too), so they are polled until settled. */
const settled = (l: Locator, prop: string) => expect.poll(() => style(l, prop));
const box = async (l: Locator) => (await l.boundingBox())!;
const texts = (l: Locator) => l.evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));

test.beforeEach(async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('a link styled as a button is an outline button in a list row, like the button beside it (#238 B1)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = await folderWithFile(page, info, 'b1', scheme);
    await openFolder(page, dir);
    // Starred, the file is listed in Recent ("Open folder", a link) and in Favourites ("Open" link beside "Remove").
    await menuButton(page, 'ledger.csv').click();
    await page.getByRole('menuitem', { name: /Add to favourites|Zu Favoriten hinzufügen/ }).click();
    await expect(page.getByRole('status')).toContainText(/ledger\.csv/);

    await page.goto('/recent');
    const open = row(page, 'ledger.csv').locator('a.button').first();
    await expect(open).toBeVisible();
    expect(await style(open, 'border-top-width')).toBe('1px');
    await settled(open, 'border-top-color').toBe(await resolved(page, 'var(--border-control)')); // #243
    expect(parseFloat(await style(open, 'padding-left'))).toBeGreaterThan(0);

    await page.goto('/favourites');
    const favRow = page.locator('tbody tr').filter({ hasText: 'ledger.csv' }).filter({ hasText: dir.slice(1) }).first();
    const openLink = favRow.locator('a.button');
    const remove = favRow.locator('button.button');
    await expect(openLink).toBeVisible();
    await settled(remove, 'border-top-color').toBe(await resolved(page, 'var(--border-control)'));
    for (const prop of ['border-top-width', 'border-top-color', 'padding-left', 'color']) {
      await settled(openLink, prop).toBe(await style(remove, prop));
    }
    expect((await box(openLink)).height).toBeCloseTo((await box(remove)).height, 0);
    await remove.click();
  }
});

test('buttons and list rows answer hover and press; the change is a short transition (#238 B2)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = await folderWithFile(page, info, 'b2', scheme);
    await openFolder(page, dir);
    await page.mouse.move(0, 0);

    const neutral = page.locator('label.button.upload:not(.primary)');
    const primary = page.locator('label.button.primary.upload');
    expect(await style(neutral, 'transition-property')).toMatch(/border-color.*background-color|background-color.*border-color/);
    expect(await style(neutral, 'transition-duration')).toMatch(/^0\.15s/);
    expect(await style(neutral, 'background-color')).toBe('rgba(0, 0, 0, 0)');

    await neutral.hover();
    await expect.poll(() => style(neutral, 'background-color')).toBe(await resolved(page, 'var(--bg)'));
    await expect.poll(() => style(neutral, 'border-top-color')).toBe(await resolved(page, 'var(--ink-muted)'));

    await primary.hover();
    await expect.poll(() => style(primary, 'background-color'))
      .toBe(await resolved(page, 'color-mix(in srgb, var(--accent) 8%, transparent)'));
    await expect.poll(() => style(primary, 'border-top-color')).toBe(await resolved(page, 'var(--accent)'));

    // Pressed: a faint ink tint while the button is held.
    const b = await box(neutral);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await expect.poll(() => style(neutral, 'background-color'))
      .toBe(await resolved(page, 'color-mix(in srgb, var(--ink) 6%, transparent)'));
    await page.mouse.move(0, 0);
    await page.mouse.up();

    // A list row takes a 3 % ink tint under the pointer.
    const r = row(page, 'ledger.csv');
    expect(await style(r, 'background-color')).toBe('rgba(0, 0, 0, 0)');
    await r.locator('.num').first().hover();
    await expect.poll(() => style(r, 'background-color'))
      .toBe(await resolved(page, 'color-mix(in srgb, var(--ink) 3%, transparent)'));
    await page.mouse.move(0, 0);
  }
  // The danger hover is the danger colour's 8 % tint (B2), seen on the danger button of the app-password confirm.
  await page.request.post('/api/v1/app-passwords', { headers: await headers(page), data: { label: `Test hover ${tag(info)}` } });
  await openPlaces(page);
  await page.getByRole('navigation', { name: /Orte|Places/ }).getByRole('link', { name: /Einstellungen|Settings/ }).click();
  const revoke = page.getByRole('button', { name: new RegExp(`Test hover ${tag(info)}`) });
  await revoke.hover();
  await expect.poll(() => style(revoke, 'background-color'))
    .toBe(await resolved(page, 'color-mix(in srgb, var(--danger) 8%, transparent)'));
  const id = ((await (await page.request.get('/api/v1/app-passwords')).json()) as { items: { id: string; label: string }[] })
    .items.find((p) => p.label === `Test hover ${tag(info)}`)!.id;
  await page.request.delete(`/api/v1/app-passwords/${id}`, { headers: await headers(page) });
});

test('a button shows its ring for the keyboard, not after a click (#238 B3)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = await folderWithFile(page, info, 'b3', scheme);
    await openFolder(page, dir);
    await menuButton(page, 'ledger.csv').click();
    await page.getByRole('menu').getByRole('menuitem', { name: /^(Details)$/ }).click();
    const drawer = page.getByRole('dialog', { name: /ledger\.csv/ });
    const star = drawer.getByRole('button', { name: /^(Favorit|Favourite)$/ });
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect(star).toBeFocused();
    expect(await style(star, 'outline-style')).toBe('none');

    // The same button reached by Tab shows the teal ring.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(star).toBeFocused();
    expect(await style(star, 'outline-style')).toBe('solid');
    expect(await style(star, 'outline-color')).toBe(await resolved(page, 'var(--line)'));
    await star.click(); // unstar again
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  }
});

test('the collision dialog reads Skip | Replace | Keep both, the forward action last and focused (#238 B4)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    const name = `b4-${scheme}-${tag(info)}.txt`;
    const upload = (text: string) => page.getByTestId('upload-input').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/home');
    await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
    await upload('old');
    await expect(page.getByRole('status')).toContainText(/1 von 1|1 of 1/);
    await upload('new');
    const dialog = page.getByRole('dialog', { name: /schon vergeben|bereits vergeben|already taken/ });
    await expect(dialog).toBeVisible();
    const buttons = dialog.locator('.app-dialog-actions button');
    const labels = await texts(buttons);
    expect(labels).toHaveLength(3);
    expect(labels[0]).toMatch(/^(Überspringen|Skip)$/);
    expect(labels[1]).toMatch(/^(Ersetzen|Replace)$/);
    expect(labels[2]).toMatch(/^(Beide behalten|Keep both)$/);
    expect(await style(buttons.nth(1), 'color')).toBe(await resolved(page, 'var(--danger)'));
    expect(await style(buttons.nth(2), 'color')).toBe(await resolved(page, 'var(--accent)'));
    await expect(buttons.nth(2)).toBeFocused();
    if (!mobile(info)) {
      // Right-aligned: the forward action ends at the dialog's content edge.
      const actions = await box(dialog.locator('.app-dialog-actions'));
      const last = await box(buttons.nth(2));
      expect(last.x + last.width).toBeCloseTo(actions.x + actions.width, 0);
    }
    await buttons.nth(0).click();
    await expect(dialog).toHaveCount(0);
  }
});

test('a confirm dialog puts Cancel left with the focus and the danger action right; revoking is a danger button (#238 B5, B8)', async ({ page }, info) => {
  const label = `Test confirm ${tag(info)}`;
  await page.request.post('/api/v1/app-passwords', { headers: await headers(page), data: { label } });
  await openPlaces(page);
  await page.getByRole('navigation', { name: /Orte|Places/ }).getByRole('link', { name: /Einstellungen|Settings/ }).click();
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    // The theme follows the device through a change listener, so the page is given that tick before reading colours.
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    const revoke = page.getByRole('button', { name: new RegExp(label) });
    await expect(revoke).toBeVisible();
    await settled(revoke, 'color').toBe(await resolved(page, 'var(--danger)'));
    await settled(revoke, 'border-top-color').toBe(await resolved(page, 'var(--danger)'));

    await revoke.click();
    const dialog = page.getByRole('dialog', { name: new RegExp(label) });
    await expect(dialog).toBeVisible();
    const buttons = dialog.locator('.app-dialog-actions button');
    const labels = await texts(buttons);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatch(/^(Abbrechen|Cancel)$/);
    expect(labels[1]).toMatch(/^(Widerrufen|Revoke)$/);
    await expect(buttons.nth(0)).toBeFocused();
    expect(await style(buttons.nth(1), 'color')).toBe(await resolved(page, 'var(--danger)'));
    const [cancel, danger] = [await box(buttons.nth(0)), await box(buttons.nth(1))];
    expect(cancel.x).toBeLessThan(danger.x);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
  const id = ((await (await page.request.get('/api/v1/app-passwords')).json()) as { items: { id: string; label: string }[] })
    .items.find((p) => p.label === label)!.id;
  await page.request.delete(`/api/v1/app-passwords/${id}`, { headers: await headers(page) });
});

test('the share dialog aligns every action row right: Share beside the access choice, the link form over a hairline (#238 B6)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = await folderWithFile(page, info, 'b6', scheme);
    await openFolder(page, dir);
    await menuButton(page, 'ledger.csv').click();
    await page.getByRole('menu').getByRole('menuitem', { name: /^(Freigeben|Share)$/ }).click();
    const dialog = page.getByRole('dialog', { name: /freigeben|Share/ });
    await expect(dialog).toBeVisible();

    // Share ends the access row at its right edge, below the member field and as high as it.
    const field = dialog.getByRole('combobox');
    const share = dialog.getByRole('button', { name: /^(Freigeben|Share)$/ });
    const form = await box(dialog.locator('form.share-form'));
    const [f, s] = [await box(field), await box(share)];
    const radio = await box(dialog.getByRole('radio').last());
    expect(s.height).toBeCloseTo(f.height, 0);
    expect(s.y).toBeGreaterThan(f.y + f.height);
    expect(radio.y + radio.height).toBeGreaterThan(s.y);
    expect(radio.y).toBeLessThan(s.y + s.height);
    expect(s.x + s.width).toBeCloseTo(form.x + form.width, 0);

    // "New public link" ends at the right edge too.
    const newLink = dialog.getByRole('button', { name: /^(Neuer öffentlicher Link|New public link)$/ });
    const content = await box(dialog.locator('section.links'));
    const n = await box(newLink);
    expect(n.x + n.width).toBeCloseTo(content.x + content.width, 0);

    // The link form ends in its own action row: a hairline above, Cancel then Create, right-aligned.
    await newLink.click();
    const linkForm = dialog.locator('form.link-form');
    const row = linkForm.locator('.app-dialog-actions');
    await expect(row).toBeVisible();
    expect(await style(row, 'border-top-width')).toBe('1px');
    expect(await style(row, 'border-top-color')).toBe(await resolved(page, 'var(--border)'));
    const labels = await texts(row.locator('button'));
    expect(labels[0]).toMatch(/^(Abbrechen|Cancel)$/);
    expect(labels[1]).toMatch(/^(Link erstellen|Create link)$/);
    const create = await box(row.locator('button').nth(1));
    const lf = await box(linkForm);
    expect(create.x + create.width).toBeCloseTo(lf.x + lf.width, 0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
});

test('a plain link is teal without an underline until hovered (#238 B7)', async ({ page }) => {
  await page.route(/\/api\/v1\/connections(\?|$)/, (r) => r.fulfill({ json: { items: [] } }));
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/migrate');
    const link = page.locator('main').getByRole('link', { name: /^(Cloud-Konten|Cloud accounts)$/ });
    await expect(link).toBeVisible();
    expect(await style(link, 'color')).toBe(await resolved(page, 'var(--line)'));
    expect(await style(link, 'text-decoration-line')).toBe('none');
    await link.hover();
    await expect.poll(() => style(link, 'text-decoration-line')).toBe('underline');
    await page.mouse.move(0, 0);
  }
});

test('buttons and fields share one height: 36 px, 44 px on the phone (#238 B9)', async ({ page }, info) => {
  const want = mobile(info) ? 44 : 36;
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/home');
    const upload = page.locator('label.button.primary.upload');
    await expect(upload).toBeVisible();
    expect((await box(upload)).height).toBeCloseTo(want, 0);
    const search = page.locator('.search-input');
    expect((await box(search)).height).toBeCloseTo(want, 0);
  }
});
