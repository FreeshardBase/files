import { expect, test, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';

// #336: on a phone a long file name stays in its own column of the row. The folder list row is a grid (checkbox, name
// block, star, menu); the star and the menu never shrink and keep their 44 px, the name never runs under them. A name
// longer than two lines is cut in the middle: its end and extension stay visible, the full name stays its accessible name
// and its title. The same holds for the other lists a phone shows: smart folder, search, Recent, Favourites, a tag and
// "My shares". Checked at the Pixel 7's width and at 320 px.

const NAMES = [
  'Screenshot_20260929_150023_Post & DHL.jpg',
  `${'Kontoauszug'.repeat(10)}0123456789.pdf`.slice(-120),
  '_'.repeat(120),
];
const SMALL = { width: 320, height: 640 };
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const box = async (l: Locator) => (await l.boundingBox())!;
type Box = Awaited<ReturnType<typeof box>>;
const EPS = 0.5;
const apart = (a: Box, b: Box) => a.x + a.width <= b.x + EPS || b.x + b.width <= a.x + EPS
  || a.y + a.height <= b.y + EPS || b.y + b.height <= a.y + EPS;
const inside = (inner: Box, outer: Box) => inner.x >= outer.x - EPS && inner.y >= outer.y - EPS
  && inner.x + inner.width <= outer.x + outer.width + EPS && inner.y + inner.height <= outer.y + outer.height + EPS;
const lines = (l: Locator) => l.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));

async function headers(page: Page) {
  const me = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin };
}
async function post(page: Page, url: string, data: unknown, status = 200) {
  const r = await page.request.post(url, { data, headers: await headers(page) });
  expect(r.status(), await r.text()).toBe(status);
  return r.json().catch(() => null) as Promise<unknown>;
}
async function mock(page: Page, url: string, body: unknown) {
  await page.route(url, (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }) : route.fallback());
}

/** A context signed in as `testuser` at `viewport`, with the phone project's other device traits. */
async function phone(browser: Browser, info: TestInfo, baseURL: string, viewport: { width: number; height: number }): Promise<Page> {
  const { userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const ctx = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
  const p = await ctx.newPage();
  await p.goto('/auth/login?login_hint=testuser&returnTo=%2Fhome');
  await expect(p.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
  return p;
}

/** The name never overlaps the row's controls, both stay inside the row; two lines at most, cut in the middle. */
async function checkName(row: Locator, name: string, controls: Locator[], what: string) {
  await expect(row).toBeVisible();
  const text = row.locator('.name-text');
  await expect(text).toHaveAttribute('title', name);
  const r = await box(row);
  const n = await box(text);
  // The row itself stays on the screen; a row wider than the phone would carry its star and menu off it.
  const screen = { x: 0, y: r.y, width: row.page().viewportSize()!.width, height: r.height };
  expect(inside(r, screen), `${what}: the row is wider than the screen`).toBe(true);
  expect(inside(n, r), `${what}: the name leaves the row`).toBe(true);
  expect(await lines(text), `${what}: the name's lines`).toBeLessThanOrEqual(2);
  // The name block: the name with its tag chips and comment badge.
  const block = await box(row.locator('.name-inner'));
  const chips = await Promise.all((await row.locator('.tag-chip').all()).map(box));
  for (const c of controls) {
    const b = await box(c);
    const label = await c.getAttribute('aria-label') ?? 'a control';
    expect(apart(block, b), `${what}: the name runs under ${label}`).toBe(true);
    for (const chip of chips) expect(apart(chip, b), `${what}: a tag chip runs under ${label}`).toBe(true);
    expect(inside(b, r), `${what}: a control leaves the row`).toBe(true);
  }
  // Cut in the middle: the tail (the end and the extension) is drawn whole inside the name, the head has the ellipsis.
  const head = text.locator('.name-head');
  // 120 characters never fit two lines of a phone's row.
  if (name.length >= 120) await expect(head, `${what}: the name is not cut`).toHaveCount(1);
  if (await head.count() > 0) {
    const tail = text.locator('.name-tail');
    expect(`${await head.textContent()}${await tail.textContent()}`, `${what}: head and tail`).toBe(name);
    expect((await tail.textContent())!.length, `${what}: the tail is empty`).toBeGreaterThan(0);
    expect(inside(await box(tail), n), `${what}: the tail is outside the name`).toBe(true);
    expect(await head.evaluate((el) => el.scrollHeight > el.clientHeight + 1), `${what}: the head is cut`).toBe(true);
  }
}

/** The folder list's row: name block, star and menu (#336). */
async function checkFolderRow(page: Page, name: string, what: string) {
  const row = page.locator('tbody tr', { has: page.locator('.name-text').getByText(name, { exact: true }) });
  const star = row.locator('.star-toggle');
  const menu = row.locator('td.menu-cell button').first();
  await checkName(row, name, [star, menu], what);
  for (const b of [star, menu]) {
    const s = await box(b);
    expect(Math.min(s.width, s.height), `${what}: a tap target under 44 px`).toBeGreaterThanOrEqual(44 - EPS);
  }
  // The accessible name of the link is the full name.
  if (!name.startsWith('_')) await expect(row.getByRole('link', { name, exact: true })).toBeVisible();
}

test.describe('phone list rows (#336)', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone widths only');
  const created: { page: Page; dir: string; smart?: string }[] = [];
  test.afterEach(async () => {
    for (const { page, dir, smart } of created.splice(0)) {
      const h = await headers(page);
      if (smart) expect((await page.request.delete(`/api/v1/smart-folders/${smart}`, { headers: h })).status()).toBe(204);
      const r = await page.request.post('/api/v1/sources/home/delete', { data: { paths: [dir] }, headers: h });
      expect(r.status(), await r.text()).toBe(204);
    }
  });

  for (const size of ['Pixel 7', '320 px'] as const) {
    test(`${size}: long names stay beside the star and the menu in every list`, async ({ page, browser, baseURL }, info) => {
      const p = size === '320 px' ? await phone(browser, info, baseURL!, SMALL) : page;
      if (p === page) {
        await page.goto('/home');
        await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
      }
      const key = `zeile-${size === '320 px' ? 'klein' : 'pixel'}-${tag(info)}`;
      const dir = `/${key}`;
      await post(p, '/api/v1/sources/home/mkdir', { path: dir }, 201);
      created.push({ page: p, dir });
      for (const n of NAMES) {
        const r = await p.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`${dir}/${n}`)}&onCollision=fail`,
          { data: Buffer.from('x'), headers: { ...await headers(p), 'content-type': 'application/octet-stream' } });
        expect(r.status(), await r.text()).toBe(201);
      }
      const paths = NAMES.map((n) => `${dir}/${n}`);
      await post(p, '/api/v1/tags/add', { source: 'home', paths, tag: key });
      // A second, long tag: its chip cuts its text instead of running under the star.
      await post(p, '/api/v1/tags/add', { source: 'home', paths, tag: `Steuererklärung Belege ${key}`.slice(0, 40) });

      // The folder list.
      await p.goto(`/home${dir}`);
      for (const n of NAMES) await checkFolderRow(p, n, `${size} folder "${n.slice(0, 20)}"`);

      // A smart folder (the folder list component) on the tag.
      const smart = await post(p, '/api/v1/smart-folders', { name: key, query: { tag: key } }, 201) as { id: string };
      created[created.length - 1]!.smart = smart.id;
      await p.goto(`/smart/${smart.id}`);
      for (const n of NAMES) await checkFolderRow(p, n, `${size} smart folder "${n.slice(0, 20)}"`);

      // The tag's own list: the name over its actions.
      await p.goto(`/tags/${encodeURIComponent(key)}`);
      for (const n of NAMES) {
        const row = p.locator('tbody tr', { has: p.locator('.name-text').getByText(n, { exact: true }) });
        await checkName(row, n, await row.locator('td.actions .button').all(), `${size} tag "${n.slice(0, 20)}"`);
      }

      // Recent and Favourites, from their answers.
      const at = '2026-10-18T09:30:00.000Z';
      await mock(p, '**/api/v1/recent', { items: NAMES.map((n) => ({ source: 'home', name: n, path: `${dir}/${n}`, type: 'file', changedAt: at })) });
      await mock(p, '**/api/v1/favourites', { items: NAMES.map((n, i) => ({ id: i + 1, source: 'home', name: n, path: `${dir}/${n}`,
        type: 'file', available: true, createdAt: at })) });
      for (const view of ['recent', 'favourites']) {
        await p.goto(`/${view}`);
        for (const n of NAMES) {
          const row = p.locator('tbody tr', { has: p.locator('.name-text').getByText(n, { exact: true }) });
          await checkName(row, n, await row.locator('td.actions .button').all(), `${size} ${view} "${n.slice(0, 20)}"`);
        }
      }

      // My shares: the item's name beside nothing, its buttons under it.
      await mock(p, '**/api/v1/links/mine', { items: NAMES.map((n, i) => ({ id: `l${i}`, token: `${'t'.repeat(31)}${i}`, label: 'Test User',
        expiresAt: null, maxDownloads: null, downloads: 0, hasPassword: false, createdAt: at, orphaned: false,
        source: 'home', path: `${dir}/${n}`, type: 'file' })) });
      await mock(p, '**/api/v1/shares/outgoing', { items: [] });
      await p.goto('/my-shares');
      const mine = p.locator('main').getByRole('list', { name: /Öffentliche Links|Public links/ });
      await expect(mine).toBeVisible();
      for (const n of NAMES) {
        const row = mine.getByRole('listitem').filter({ has: p.locator('.mine-item-name').getByText(n, { exact: true }) });
        const name = row.locator('.mine-item-name');
        const r = await box(row);
        const b = await box(name);
        expect(r.x + r.width, `${size} my shares: the row is wider than the screen`).toBeLessThanOrEqual(p.viewportSize()!.width + EPS);
        expect(inside(b, r), `${size} my shares: the name leaves the row`).toBe(true);
        for (const c of await row.getByRole('button').all()) expect(apart(b, await box(c)), `${size} my shares: the name runs under a button`).toBe(true);
      }

      // The search's results: each name stays inside its option.
      await p.goto('/home');
      for (const q of ['Screenshot_20260929_150023', 'KontoauszugKontoauszug']) {
        await p.getByRole('combobox', { name: /Dateien nach Namen suchen|Search files by name/ }).fill(q);
        const options = p.getByRole('listbox', { name: /Suchergebnisse|Search results/ }).getByRole('option');
        await expect(options.first()).toBeVisible();
        for (const o of await options.all()) {
          expect(inside(await box(o.locator('.search-name')), await box(o)), `${size} search "${q}": the name leaves the option`).toBe(true);
        }
      }
      await p.unrouteAll({ behavior: 'ignoreErrors' });
    });
  }
});
