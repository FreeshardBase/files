import { expect, test, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openPlaces } from './places.ts';

// #237: responsive tables and name truncation. A name keeps a usable column and breaks between words only, at most two
// lines with the full name in `title` (L1, L3); on a tablet (≤900 px) the lists take the phone's stacked rows (L1, L2);
// a failed upload's reason gets its own row (L4); locations, sidebar accounts and e-mails stay one line with an ellipsis
// (L5–L7); the members' quota form stays one row (L7); a gallery tile keeps the end of the name and its extension (L8).
// Every check runs in both projects (desktop, phone) and both themes; the tablet checks open an 834 px wide context.

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];
const TABLET = { width: 834, height: 1112 };
// Lists with buttons in their rows stack below 1200 px (DECISIONS.md, 2026-10-16).
const LAPTOP = { width: 1100, height: 800 };
/** The name column's least width, 12rem at the browser's 16 px root size. */
const REM12 = 12 * 16 - 0.5;
const LONG = 'Präsentation Quartalsbericht Projekte 2026 endgültig überarbeitet (bitte nicht löschen).pdf';
const SHORT = 'Einkaufsliste.md';
const DEEP = '/Schule/Projekte/Mathematik/Hausaufgaben im Oktober und November';
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });

async function headers(page: Page) {
  const me = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin };
}
async function putSettings(page: Page, locale: 'de-du' | null, theme: Scheme | 'system') {
  const r = await page.request.put('/api/v1/settings', { data: { locale, theme }, headers: await headers(page) });
  expect(r.status(), await r.text()).toBe(200);
}
/** Folders this spec made in the home root; removed after each test so other specs' rows stay in a phone's window. */
const created: string[] = [];
async function mkdir(page: Page, path: string) {
  const r = await page.request.post('/api/v1/sources/home/mkdir', { data: { path }, headers: await headers(page) });
  expect([201, 409]).toContain(r.status());
  created.push(path);
}
async function putFile(page: Page, path: string, body: Buffer | string = 'x') {
  const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=replace`, {
    data: Buffer.from(body), headers: { ...await headers(page), 'content-type': 'application/octet-stream' } });
  expect(r.status(), await r.text()).toBeLessThan(300);
}
/** A folder holding a short and a long file name. */
async function namesFolder(page: Page, dir: string) {
  await mkdir(page, dir);
  await putFile(page, `${dir}/${SHORT}`);
  await putFile(page, `${dir}/${LONG}`, Buffer.alloc(2_400_000));
}

/** A context signed in as `testuser` at the tablet width, with the project's other device traits. */
async function tablet(browser: Browser, info: TestInfo, baseURL: string, viewport = TABLET): Promise<Page> {
  const { userAgent, deviceScaleFactor } = info.project.use;
  const ctx = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor });
  const p = await ctx.newPage();
  await p.goto('/auth/login?login_hint=testuser&returnTo=%2Fhome');
  await expect(p.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
  return p;
}

/** How many lines the element's text takes (its content box over its line height). */
const lines = (l: Locator) => l.evaluate((el) => {
  const s = getComputedStyle(el);
  const content = el.getBoundingClientRect().height - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)
    - parseFloat(s.borderTopWidth) - parseFloat(s.borderBottomWidth);
  return Math.round(content / parseFloat(s.lineHeight));
});
const box = async (l: Locator) => (await l.boundingBox())!;
async function noSideways(page: Page, what: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${what} scrolls sideways`).toBeLessThanOrEqual(0);
}
/** Whether the text is cut with an ellipsis: a `nowrap` line wider than its box with `text-overflow: ellipsis`, or a
 *  one-line clamp with more text than that line. */
const ellipsized = (l: Locator) => l.evaluate((el) => {
  const s = getComputedStyle(el);
  if (s.webkitLineClamp === '1') return el.scrollHeight > el.clientHeight + 1;
  return s.textOverflow === 'ellipsis' && s.whiteSpace === 'nowrap' && el.scrollWidth > el.clientWidth;
});

/** The folder list's name checks: no break inside a word, two lines at most, the full name in `title`. */
async function checkNames(page: Page, what: string) {
  const short = row(page, SHORT).locator('.name-text');
  const long = row(page, LONG).locator('.name-text');
  expect(await lines(short), `${what}: "${SHORT}" breaks`).toBe(1);
  expect(await lines(long), `${what}: the long name's lines`).toBeLessThanOrEqual(2);
  await expect(long).toHaveAttribute('title', LONG);
  // At least 12rem for the name, at any width.
  expect((await box(row(page, LONG).locator('td.name'))).width, `${what}: the name's width`).toBeGreaterThanOrEqual(REM12);
  // The name is drawn above the size line, never over it (L3: the touch target's negative margin on a wrapped name).
  const name = await box(long);
  const size = await box(row(page, LONG).locator('td.size'));
  if (size.y > name.y) expect(name.y + name.height, `${what}: the name overlaps the size`).toBeLessThanOrEqual(size.y + 0.5);
  await noSideways(page, what);
}

const trashBody = (name: string, origin: string) => ({ totalSize: 2_400_000, retentionDays: 30, items: [
  { id: 'a'.repeat(32), name, originalPath: `${origin}/${name}`, type: 'file', size: 2_400_000, deletedAt: '2026-10-16T09:30:00.000Z' }] });
const recentBody = (name: string, origin: string) => ({ items: [
  { source: 'home', name, path: `${origin}/${name}`, type: 'file', changedAt: '2026-10-16T09:30:00.000Z' }] });
async function mock(page: Page, url: string, body: unknown) {
  await page.route(url, (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }) : route.fallback());
}

test.beforeEach(async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await putSettings(page, null, 'system');
  if (created.length === 0) return;
  const r = await page.request.post('/api/v1/sources/home/delete', { data: { paths: created.splice(0) }, headers: await headers(page) });
  expect(r.status(), await r.text()).toBe(204);
});

for (const scheme of SCHEMES) {
  test(`${scheme}: folder list names break between words, take two lines at most and keep 12rem, also on a tablet (L1, L3)`, async ({ page, browser, baseURL }, info) => {
    const dir = `/namen-${scheme}-${tag(info)}`;
    await namesFolder(page, dir);
    await putSettings(page, 'de-du', scheme);
    await page.goto(`/home${dir}`);
    await expect(row(page, LONG)).toBeVisible();
    await checkNames(page, info.project.name);

    const t = await tablet(browser, info, baseURL!);
    await t.goto(`/home${dir}`);
    await expect(row(t, LONG)).toBeVisible();
    await expect(t.locator('html')).toHaveAttribute('data-theme', scheme);
    await checkNames(t, 'tablet');
    // The tablet uses the phone's rows: the header row is hidden and the size line sits under the name.
    await expect(t.locator('.file-list thead th').first()).not.toBeInViewport();
    expect((await box(row(t, LONG).locator('td.size'))).y).toBeGreaterThan((await box(row(t, LONG).locator('.name-text'))).y);
    await t.context().close();
  });

  test(`${scheme}: trash rows on a tablet and a small laptop stack the actions under the name and never scroll sideways (L2)`, async ({ page, browser, baseURL }, info) => {
    await putSettings(page, 'de-du', scheme);
    for (const p of [page, await tablet(browser, info, baseURL!), await tablet(browser, info, baseURL!, LAPTOP)]) {
      await mock(p, '**/api/v1/trash', trashBody(LONG, DEEP));
      await p.goto('/trash');
      const r = row(p, LONG);
      await expect(r).toBeVisible();
      const what = p === page ? info.project.name : `${p.viewportSize()!.width} px`;
      expect(await lines(r.locator('.name-text')), `${what}: the name's lines`).toBeLessThanOrEqual(2);
      expect((await box(r.locator('td.name'))).width, `${what}: the name's width`).toBeGreaterThanOrEqual(REM12);
      await expect(r.locator('.name-text')).toHaveAttribute('title', LONG);
      // Each action button is one line high.
      for (const b of await r.locator('td.actions .button').all()) expect((await box(b)).height, `${what}: a wrapped button`).toBeLessThanOrEqual(44);
      await noSideways(p, `${what} trash`);
      if (p !== page) {
        const name = await box(r.locator('.name-text'));
        expect((await box(r.locator('td.actions'))).y, `${what}: the actions sit under the name`).toBeGreaterThanOrEqual(name.y + name.height);
        await p.context().close();
      }
    }
  });

  test(`${scheme}: the location in Recent and Trash is one line with an ellipsis and the full path in its title (L5)`, async ({ page, browser, baseURL }, info) => {
    await putSettings(page, 'de-du', scheme);
    for (const p of [page, await tablet(browser, info, baseURL!)]) {
      await mock(p, '**/api/v1/recent', recentBody('Notizen.txt', DEEP));
      await mock(p, '**/api/v1/trash', trashBody('Notizen.txt', DEEP));
      for (const view of ['recent', 'trash']) {
        await p.goto(`/${view}`);
        const origin = row(p, 'Notizen.txt').locator('.origin-text');
        // The full location, written from the root's name (#244).
        await expect(origin).toHaveAttribute('title', 'Mein Speicher › Schule › Projekte › Mathematik › Hausaufgaben im Oktober und November');
        expect(await lines(origin), `${view}: the location's lines`).toBe(1);
        expect(await ellipsized(origin), `${view}: the location is cut with an ellipsis`).toBe(true);
        await noSideways(p, view);
      }
      if (p !== page) await p.context().close();
    }
  });

  test(`${scheme}: a failed upload with a long name keeps the name readable; its reason takes its own row on the phone (L4)`, async ({ page }, info) => {
    const dir = `/hochladen-${scheme}-${tag(info)}`;
    await mkdir(page, dir);
    await putSettings(page, 'de-du', scheme);
    await page.goto(`/home${dir}`);
    await expect(page.getByRole('navigation', { name: 'Pfad' })).toBeVisible();
    await page.route('**/api/v1/uploads**', (route) => route.abort('internetdisconnected'));
    const name = 'Scan 2026-10-16 Steuerbescheid Finanzamt.pdf';
    await page.getByTestId('upload-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    const item = page.locator('.upload-item', { has: page.locator('.upload-name', { hasText: name }) });
    await expect(item).toHaveAttribute('data-state', 'failed', { timeout: 20_000 });
    const nameBox = await box(item.locator('.upload-name'));
    expect(nameBox.width, 'the name column').toBeGreaterThanOrEqual(8 * 15 - 1);
    expect(await lines(item.locator('.upload-name')), 'the name breaks letter by letter').toBeLessThanOrEqual(2);
    if (info.project.name.startsWith('mobile')) {
      const state = await box(item.locator('.upload-state'));
      expect(state.y, 'the reason sits under the name').toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 0.5);
    }
    await noSideways(page, 'upload panel');
  });

  test(`${scheme}: a sidebar connection shows the provider over the account, each one line with an ellipsis (L6)`, async ({ page }) => {
    // Longer than the phone's full-width sidebar, too.
    const account = 'testuser.mit.einem.sehr.sehr.langen.namen.fuer.die.seitenleiste.auch.auf.dem.telefon@example.com';
    await mock(page, '**/api/v1/connections', { providers: [], items: [{ id: 'c'.repeat(32), source: `conn:${'c'.repeat(32)}`,
      provider: 'fake', providerName: 'Fake Cloud', account, status: 'ok', createdAt: '2026-10-16T09:30:00.000Z' }] });
    await putSettings(page, 'de-du', scheme);
    await page.goto('/home');
    const nav = await openPlaces(page);
    const link = nav.locator('.nav-connection');
    await expect(link).toBeVisible();
    const provider = link.locator('.nav-connection-provider');
    const acct = link.locator('.nav-connection-account');
    await expect(provider).toHaveText('Fake Cloud');
    await expect(acct).toHaveAttribute('title', account);
    expect((await box(provider)).y, 'the provider is the first line').toBeLessThan((await box(acct)).y);
    expect(await lines(acct), 'the account lines').toBe(1);
    expect(await ellipsized(acct), 'the account is cut with an ellipsis').toBe(true);
    // The provider is the main line in ink, the account the muted line under it.
    const color = (l: Locator) => l.evaluate((el) => getComputedStyle(el).color);
    expect(await color(provider)).not.toBe(await color(acct));
    expect(parseFloat(await provider.evaluate((el) => getComputedStyle(el).fontSize)))
      .toBeGreaterThan(parseFloat(await acct.evaluate((el) => getComputedStyle(el).fontSize)));
  });

  test(`${scheme}: members keep the quota form on one row and the e-mail on one line, also on a tablet (L7)`, async ({ page, browser, baseURL }, info) => {
    const email = 'testuser.mit.einem.sehr.langen.namen@example.com';
    const body = { items: [{ id: 'm'.repeat(8), displayName: 'Test User', email, role: 'member', used: 2_400_000, quota: 5_000_000_000 }] };
    await putSettings(page, 'de-du', scheme);
    for (const p of [page, await tablet(browser, info, baseURL!), await tablet(browser, info, baseURL!, LAPTOP)]) {
      await mock(p, '**/api/v1/admin/members', body);
      await p.goto('/members');
      const r = p.locator('.members-list tbody tr').first();
      await expect(r).toBeVisible();
      const what = p === page ? info.project.name : `${p.viewportSize()!.width} px`;
      const mail = r.locator('.members-email');
      await expect(mail).toHaveAttribute('title', email);
      expect(await lines(mail), `${what}: the e-mail breaks`).toBe(1);
      const field = await box(r.locator('.members-amount'));
      const set = await box(r.getByRole('button', { name: 'Speicherlimit für Test User festlegen', exact: true }));
      if (!info.project.name.startsWith('mobile') || p !== page) {
        expect(Math.abs(set.y - field.y), `${what}: the button is beside the field`).toBeLessThan(2);
        expect(Math.abs((await box(r.locator('.members-unit'))).y - field.y), `${what}: the unit is beside the field`).toBeLessThan(2);
      }
      for (const th of await p.locator('.members-list thead th').all()) {
        // On stacked rows the header row is only there for screen readers (a 1 px box).
        if ((await box(th)).width > 1) expect(await lines(th), `${what}: a header wraps`).toBe(1);
      }
      if (p !== page || info.project.name.startsWith('mobile')) {
        const name = await box(r.locator('.members-name'));
        expect(field.y, `${what}: the form sits under the name`).toBeGreaterThanOrEqual(name.y + name.height - 0.5);
      }
      await noSideways(p, `${what} members`);
      if (p !== page) await p.context().close();
    }
  });

  test(`${scheme}: a gallery tile cuts a long name in the middle and keeps its extension (L8)`, async ({ page }, info) => {
    const dir = `/fotos-${scheme}-${tag(info)}`;
    const name = 'Sonnenuntergang am Strand mit der ganzen Familie.png';
    await mkdir(page, dir);
    await putFile(page, `${dir}/${name}`);
    await putSettings(page, 'de-du', scheme);
    await page.goto(`/home${dir}`);
    const toggle = page.getByRole('group', { name: 'Ansicht' });
    await toggle.getByRole('button', { name: 'Galerie' }).click();
    try {
      const gallery = page.getByRole('list', { name: /Galerie/ });
      const tile = gallery.getByRole('button', { name, exact: true });
      await expect(tile).toBeVisible();
      const label = tile.locator('.gallery-name');
      await expect(label).toHaveAttribute('title', name);
      await expect(label).toHaveText(name);
      const tail = label.locator('.gallery-name-tail');
      await expect(tail).toHaveText(/\.png$/);
      // The tail is drawn whole inside the tile; the head before it carries the ellipsis.
      const [t, l] = [await box(tail), await box(label)];
      expect(t.x + t.width, 'the extension is inside the tile').toBeLessThanOrEqual(l.x + l.width + 0.5);
      expect(await tail.evaluate((el) => el.scrollWidth <= el.clientWidth + 0.5), 'the tail is cut').toBe(true);
      expect(await label.locator('.gallery-name-head').evaluate((el) => getComputedStyle(el).textOverflow === 'ellipsis'
        && el.scrollWidth > el.clientWidth)).toBe(true);
    } finally {
      // The view is remembered on the device; the next test starts in the list.
      await toggle.getByRole('button', { name: 'Liste' }).click();
    }
  });
}

// #309: the page column is at most 960 px, so on a wide window the German trash row (a 12rem name, the location,
// "Wiederherstellen" and "Endgültig löschen") must fit in it at every desktop width, like every other list.
for (const width of [1280, 1920]) {
  test(`the German trash list stays inside the page column at ${width} px (#309)`, async ({ page, browser, baseURL }, info) => {
    await putSettings(page, 'de-du', 'system');
    const p = await tablet(browser, info, baseURL!, { width, height: 800 });
    await mock(p, '**/api/v1/trash', trashBody(LONG, DEEP));
    await p.goto('/trash');
    const r = row(p, LONG);
    await expect(r).toBeVisible();
    await expect(r.getByRole('button', { name: 'Endgültig löschen' })).toBeVisible();
    const right = (sel: string) => p.locator(sel).evaluate((el) => el.getBoundingClientRect().right);
    const column = await right('.page');
    expect(await right('table.trash-list'), 'the table ends past the page column').toBeLessThanOrEqual(column + 0.5);
    for (const b of await r.locator('td.actions .button').all()) {
      const b0 = await box(b);
      expect(b0.height, 'a wrapped button').toBeLessThanOrEqual(44);
      expect(b0.x + b0.width, 'a button past the page column').toBeLessThanOrEqual(column + 0.5);
    }
    expect((await box(r.locator('td.name'))).width, 'the name\'s width').toBeGreaterThanOrEqual(REM12);
    await p.context().close();
  });
}
