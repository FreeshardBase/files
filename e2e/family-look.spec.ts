import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openPlaces, places } from './places.ts';
import { solidPng } from '../server/test/support/fakeDrive.ts';

// #244: Files looks like Calendar's family member, and a folder's location is written one way everywhere.
// T10: the header's line logo and teal name, the member as an avatar initial, no keyboard help on a touch screen; the
// sidebar 240 px wide in three labelled groups with hairlines, a square left edge on the current place, which stays
// current in subfolders; every dialog's head and action row on hairlines.
// T12: "Mein Speicher › ordner › Projekte" in Recent, Favourites, search and the largest folders; a cloud's provider
// as the search group label and the root crumb, its account beside it in its own case; thumbnails in Recent and
// Favourites. Runs in both projects (desktop, phone), light and dark; each test sets its language and theme and
// resets them afterwards.
type Settings = { locale: 'de-du' | 'de-sie' | 'en' | null; theme: 'light' | 'dark' | 'system' };
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const crumbs = (page: Page) => page.getByRole('navigation', { name: /Pfad|Path/ });

async function headers(page: Page) {
  const me = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin };
}
async function putSettings(page: Page, s: Settings) {
  const r = await page.request.put('/api/v1/settings', { data: s, headers: await headers(page) });
  expect(r.status(), await r.text()).toBe(200);
}
async function mkdir(page: Page, path: string, source = 'home') {
  const r = await page.request.post(`/api/v1/sources/${source}/mkdir`, { data: { path }, headers: await headers(page) });
  expect(r.status(), await r.text()).toBe(201);
}
// Every folder of this spec lives under one parent: by the end of a full run the home root is long, and only a window
// of it is rendered (#225).
const PARENT = 'familie-244';
async function parent(page: Page) {
  const r = await page.request.post('/api/v1/sources/home/mkdir', { data: { path: `/${PARENT}` }, headers: await headers(page) });
  expect([201, 409]).toContain(r.status());
}
async function put(page: Page, path: string, data: Buffer) {
  const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=fail`,
    { headers: { ...(await headers(page)), 'content-type': 'application/octet-stream' }, data });
  expect(r.status(), await r.text()).toBe(201);
}
async function star(page: Page, source: string, path: string) {
  const r = await page.request.post('/api/v1/favourites', { data: { source, path }, headers: await headers(page) });
  expect(r.status(), await r.text()).toBeLessThan(300);
}
/** The computed colour of a theme token, as the browser writes a `color`. */
const tokenColor = (page: Page, token: string) => page.evaluate((t) => {
  const probe = document.createElement('span');
  probe.style.color = `var(${t})`;
  document.body.append(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}, token);
const css = (l: Locator, prop: string) => l.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
const coarse = (page: Page) => page.evaluate(() => matchMedia('(pointer: coarse)').matches);

test.describe('in the home', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/home');
    await expect(places(page)).toBeAttached();
  });
  test.afterEach(async ({ page }) => { await putSettings(page, { locale: null, theme: 'system' }); });

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: the header has Calendar's logo and teal name, and the member as an avatar initial (F1, F6)`, async ({ page }, info) => {
      await putSettings(page, { locale: 'de-du', theme });
      await page.reload();
      const title = page.locator('.app-title');
      await expect(title).toHaveText('Dateien');
      const logo = title.locator('.app-logo');
      await expect(logo).toBeVisible();
      expect(await logo.evaluate((el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height])).toEqual([22, 22]);
      expect(await css(logo, 'background-color')).toBe(await tokenColor(page, '--line'));
      expect(await css(title, 'color')).toBe(await tokenColor(page, '--line'));
      expect(await css(title, 'font-weight')).toBe('600');
      expect(await css(title, 'font-size')).toBe('16px');

      const user = page.getByRole('banner').locator('.app-user');
      await expect(user).toHaveAttribute('title', 'Test User');
      const avatar = user.locator('.fs-avatar');
      await expect(avatar).toHaveText('T');
      expect(await avatar.evaluate((el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height])).toEqual([24, 24]);
      expect(await css(avatar, 'border-radius')).toBe('50%');
      // The name stays for screen readers on the phone and beside the initial on a wide screen.
      await expect(page.getByRole('banner')).toContainText('Test User');
      const phone = info.project.name === 'mobile-chrome';
      if (phone) expect(await user.locator('.app-user-name').evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
      else await expect(user.locator('.app-user-name')).toBeVisible();

      // Keyboard help is for a keyboard: gone on the phone's touch screen, there on the desktop.
      expect(await coarse(page)).toBe(phone);
      const keys = page.getByRole('button', { name: 'Tastenkürzel' });
      if (phone) await expect(keys).toBeHidden();
      else await expect(keys).toBeVisible();
    });

    test(`${theme}: the sidebar is 240 px in three labelled groups with hairlines, and the current place has a straight bar (F2, F3, F4)`, async ({ page }, info) => {
      const dir = `${PARENT}/familie-${theme}-${tag(info)}`;
      await parent(page);
      await mkdir(page, `/${dir}`);
      await mkdir(page, `/${dir}/Projekte`);
      await putSettings(page, { locale: 'de-du', theme });
      await page.goto(`/home/${dir}/Projekte`);
      await expect(crumbs(page)).toContainText('Projekte');
      const nav = await openPlaces(page);
      const phone = info.project.name === 'mobile-chrome';
      if (!phone) expect(await nav.evaluate((el) => el.getBoundingClientRect().width)).toBe(240);

      // "Dateianfragen" may carry the badge of new files that other tests' file requests received (#217).
      const groups: [string, (string | RegExp)[]][] = [
        ['Orte', ['Mein Speicher', 'Cloud-Konten']],
        ['Sammlungen', ['Favoriten', 'Zuletzt geändert', 'Für mich freigegeben', /^\s*Dateianfragen\s*(\d+\s*(eine neue Datei|\d+ neue Dateien)\s*)?$/, 'Papierkorb']],
        ['Verwaltung', ['Speicherbelegung', 'Mitglieder', 'Einstellungen', 'Auf den Shard umziehen']],
      ];
      const hairline = await tokenColor(page, '--border');
      for (const [i, [label, links]] of groups.entries()) {
        const group = nav.getByRole('group', { name: label, exact: true });
        await expect(group).toBeVisible();
        const title = group.locator('.nav-group-title');
        expect(await css(title, 'text-transform')).toBe('uppercase');
        expect(await css(title, 'font-size')).toBe('10px');
        await expect(group.getByRole('link')).toHaveText(links);
        // A hairline between the groups, none above the first.
        expect(await css(group, 'border-top-width')).toBe(i === 0 ? '0px' : '1px');
        if (i > 0) expect(await css(group, 'border-top-color')).toBe(hairline);
      }
      // "Auf den Shard umziehen" fits one line: it is as high as a one-word entry.
      const height = (name: string) => nav.getByRole('link', { name, exact: true }).evaluate((el) => el.getBoundingClientRect().height);
      expect(await height('Auf den Shard umziehen')).toBe(await height('Einstellungen'));

      // In a subfolder "Mein Speicher" is still the current place, marked by a straight teal bar.
      const home = nav.getByRole('link', { name: 'Mein Speicher', exact: true });
      await expect(home).toHaveClass(/\bactive\b/);
      expect(await css(home, 'border-left-width')).toBe('2px');
      expect(await css(home, 'border-left-color')).toBe(await tokenColor(page, '--line'));
      expect(await css(home, 'border-top-left-radius')).toBe('0px');
      expect(await css(home, 'border-bottom-left-radius')).toBe('0px');
      expect(await css(home, 'border-top-right-radius')).toBe('8px');
      await expect(nav.getByRole('link', { name: 'Papierkorb', exact: true })).not.toHaveClass(/\bactive\b/);
    });

    test(`${theme}: a dialog's head and action row sit on hairlines (F5)`, async ({ page }) => {
      await putSettings(page, { locale: 'de-du', theme });
      await page.reload();
      await expect(crumbs(page)).toBeVisible();
      await page.keyboard.press('?');
      const help = page.getByRole('dialog', { name: 'Tastenkürzel' });
      await expect(help).toBeVisible();
      const hairline = await tokenColor(page, '--border');
      const head = help.locator('.app-dialog-head');
      expect(await css(head, 'border-bottom-width')).toBe('1px');
      expect(await css(head, 'border-bottom-color')).toBe(hairline);
      await expect(head.getByRole('heading', { name: 'Tastenkürzel' })).toBeVisible();
      const actions = help.locator('.app-dialog-actions');
      expect(await css(actions, 'border-top-width')).toBe('1px');
      expect(await css(actions, 'border-top-color')).toBe(hairline);
      await expect(actions.getByRole('button', { name: 'Schließen' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(help).toHaveCount(0);
    });
  }

  test('a folder is "Mein Speicher › …" in Recent, Favourites and search, and images show thumbnails (P1, P4)', async ({ page }, info) => {
    const own = `orte-${tag(info)}`;
    const dir = `${PARENT}/${own}`;
    const photo = `foto-${tag(info)}.png`;
    await parent(page);
    await mkdir(page, `/${dir}`);
    await mkdir(page, `/${dir}/Projekte`);
    await put(page, `/${dir}/Projekte/${photo}`, await solidPng(64, 48, '#007080'));
    await star(page, 'home', `/${dir}/Projekte`);
    await star(page, 'home', `/${dir}/Projekte/${photo}`);
    await putSettings(page, { locale: 'de-du', theme: 'light' });
    const where = `Mein Speicher › ${PARENT} › ${own} › Projekte`;

    await page.goto('/recent');
    const recent = row(page, photo);
    await expect(recent.locator('.origin-text')).toHaveText(where);
    await expect(recent.locator('.origin-text')).toHaveAttribute('title', where);
    const thumb = recent.locator('img.row-thumb');
    await expect(thumb).toBeVisible();
    await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    expect(await thumb.evaluate((el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height])).toEqual([28, 28]);

    await page.goto('/favourites');
    // Both projects star a "Projekte"; this one is the row in this test's folder.
    const folder = row(page, 'Projekte').filter({ hasText: own });
    await expect(folder.locator('.origin-text')).toHaveText(`Mein Speicher › ${PARENT} › ${own}`);
    await expect(row(page, photo).locator('.origin-text')).toHaveText(where);
    await expect(row(page, photo).locator('img.row-thumb')).toBeVisible();
    await expect(folder.locator('img.row-thumb')).toHaveCount(0);

    await page.goto('/home');
    await page.getByRole('combobox', { name: 'Dateien nach Namen suchen' }).fill(photo);
    const option = page.getByRole('option', { name: new RegExp(photo.replace(/[.]/g, '\\.')) });
    await expect(option.locator('.search-location')).toHaveText(where);
    await expect(page.getByRole('group', { name: 'Mein Speicher', exact: true })).toBeVisible();
    // Nowhere a path with a leading slash.
    for (const text of await page.locator('.search-location').allTextContents()) expect(text).not.toMatch(/^\//);
  });
});

test.describe('with a cloud connection', () => {
  test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

  test('the cloud is its provider in crumbs and search, with the account beside it in its own case (P2, P3, F4)', async ({ page }) => {
    await page.goto('/auth/login?returnTo=%2Fconnections');
    await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
    const h = await headers(page);
    for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
      expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers: h })).status()).toBe(204);
    }
    await putSettings(page, { locale: 'de-du', theme: 'light' });
    try {
      await page.reload();
      // Dropbox, since the fake's Dropbox can be searched (e2e/cloudServer.ts: /Reports/Q3 Übersicht.txt).
      await page.getByRole('button', { name: 'Dropbox verbinden' }).click();
      await page.getByRole('button', { name: 'Allow' }).click();
      await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);

      // The root crumb is the provider; the account is a muted, small note beside it.
      const root = crumbs(page).getByRole('link').first();
      await expect(root).toHaveText('Dropbox');
      const note = crumbs(page).locator('.crumb-note');
      await expect(note).toHaveText('testuser@example.com');
      await expect(note).toHaveAttribute('title', 'testuser@example.com');
      expect(await css(note, 'color')).toBe(await tokenColor(page, '--ink-muted'));
      expect(await css(note, 'font-size')).toBe('13px');
      await expect(crumbs(page)).not.toContainText(':');

      // In a subfolder the connection stays the current place.
      await row(page, 'Reports').getByRole('button', { name: 'Reports', exact: true }).click();
      await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}\/Reports$/);
      await expect(crumbs(page).getByRole('link').first()).toHaveText('Dropbox');
      await expect(crumbs(page).locator('.crumb-note')).toHaveText('testuser@example.com');
      const nav = await openPlaces(page);
      await expect(nav.getByRole('link', { name: /testuser@example\.com/ })).toHaveClass(/\bactive\b/);
      await expect(nav.getByRole('link', { name: 'Mein Speicher', exact: true })).not.toHaveClass(/\bactive\b/);

      // Search: the group is labelled by the provider in capitals, the account keeps its case.
      await page.getByRole('combobox', { name: 'Dateien nach Namen suchen' }).fill('Übersicht');
      const group = page.getByRole('group', { name: 'Dropbox testuser@example.com', exact: true });
      await expect(group).toBeVisible();
      const source = group.locator('.search-group-source');
      await expect(source).toHaveText('Dropbox');
      expect(await source.evaluate((el) => (el as HTMLElement).innerText)).toBe('DROPBOX');
      expect(await css(source, 'text-transform')).toBe('uppercase');
      const account = group.locator('.search-group-account');
      await expect(account).toHaveText('testuser@example.com');
      expect(await css(account, 'text-transform')).toBe('none');
      expect(await css(account, 'font-size')).toBe('13px');
      expect(await account.evaluate((el) => (el as HTMLElement).innerText.trim())).toBe('testuser@example.com');
      await expect(group.getByRole('option', { name: /Q3 Übersicht\.txt/ }).locator('.search-location')).toHaveText('Dropbox › Reports');
    } finally {
      await putSettings(page, { locale: null, theme: 'system' });
      for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
        expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers: h })).status()).toBe(204);
      }
    }
  });
});
