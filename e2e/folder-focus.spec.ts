import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';

// #228: opening a folder from the keyboard keeps the focus in the folder. While the folder loads the list stays mounted
// (marked busy, inert) and the folder's content region holds the focus; then the first row (or tile) gets it, or the
// region itself when the folder is empty. Back puts it on the row of the folder that was open.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const crumbs = (page: Page) => page.getByRole('navigation', { name: /Pfad|Path/ });
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const content = (page: Page) => page.getByRole('region', { name: /Inhalt von|Contents of/ });
const focusedRowName = (page: Page) => page.evaluate(() => document.activeElement?.closest('tr')?.querySelector('.name')?.textContent?.trim());
const focusedTileName = (page: Page) => page.evaluate(() => document.activeElement?.closest('.gallery-tile')?.querySelector('.gallery-name')?.textContent?.trim());

async function setup(page: Page, dir: string, paths: string[]) {
  await page.goto('/');
  await expect(crumbs(page)).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  for (const p of [`/${dir}`, ...paths.map((f) => `/${dir}/${f}`)]) {
    expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: p } })).status()).toBe(201);
  }
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(crumbs(page)).toContainText(dir);
}
/** Holds back the listing of `path` until the returned function is called. */
async function holdListing(page: Page, path: string) {
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const held = new Promise<void>((seen) => {
    void page.route('**/api/v1/sources/home/list?**', async (route: Route) => {
      if (new URL(route.request().url()).searchParams.get('path') !== path) return route.fallback();
      seen();
      await released;
      await route.fallback();
    });
  });
  return { held, release };
}

test('Enter on a folder keeps the list mounted while it loads, then focuses the first row; Back returns to the folder row', async ({ page }, info) => {
  const dir = `focus-${tag(info)}`;
  await setup(page, dir, ['a', 'b', 'b/inner1', 'b/inner2', 'c']);
  await expect(row(page, 'c')).toBeVisible();

  const { held, release } = await holdListing(page, `/${dir}/b`);
  await row(page, 'a').focus();
  await page.keyboard.press('ArrowDown');
  expect(await focusedRowName(page)).toBe('b');
  await page.keyboard.press('Enter');
  await held;
  await expect(crumbs(page)).toContainText('b');
  // Loading: the list is still there (busy), and the focus waits on the folder's content, not on <body>.
  await expect(content(page)).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('table')).toBeAttached();
  await expect(content(page)).toBeFocused();
  release();

  await expect(row(page, 'inner1')).toBeVisible();
  await expect(content(page)).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => focusedRowName(page)).toBe('inner1');
  await page.unroute('**/api/v1/sources/home/list?**');

  await page.goBack();
  await expect(row(page, 'c')).toBeVisible();
  await expect.poll(() => focusedRowName(page)).toBe('b');
  // The roving tab stop is on that row too: arrows go on from there.
  await page.keyboard.press('ArrowDown');
  expect(await focusedRowName(page)).toBe('c');
});

test('an empty folder puts the focus on its content region; Back from two levels down lands on the folder above', async ({ page }, info) => {
  const dir = `focus-empty-${tag(info)}`;
  await setup(page, dir, ['x', 'y', 'y/empty']);
  await row(page, 'y').focus();
  await page.keyboard.press('Enter');
  await expect(row(page, 'empty')).toBeVisible();
  await expect.poll(() => focusedRowName(page)).toBe('empty');
  await page.keyboard.press('Enter');
  await expect(content(page)).toContainText(/leer|empty/);
  await expect(content(page)).toBeFocused();

  // Up two levels with the breadcrumb: the row on the way down to where we were gets the focus.
  await crumbs(page).getByRole('link', { name: dir, exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(row(page, 'x')).toBeVisible();
  await expect.poll(() => focusedRowName(page)).toBe('y');
});

test('in the gallery, opening a folder focuses its first tile, and Back the folder tile', async ({ page }, info) => {
  const dir = `focus-gallery-${tag(info)}`;
  await setup(page, dir, ['f1', 'f2', 'f2/g1', 'f2/g2']);
  await page.getByRole('button', { name: /^(Galerie|Gallery)$/ }).click();
  const tile = page.locator('.gallery-tile', { hasText: 'f2' });
  await tile.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.gallery-tile', { hasText: 'g2' })).toBeVisible();
  await expect.poll(() => focusedTileName(page)).toBe('g1');
  await page.goBack();
  await expect(page.locator('.gallery-tile', { hasText: 'f1' })).toBeVisible();
  await expect.poll(() => focusedTileName(page)).toBe('f2');
});
