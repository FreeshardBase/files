import { expect, test, type Page, type TestInfo } from '@playwright/test';

// #225: a folder of 5000 files. The list and the gallery render only what is near the viewport, so the folder shows in
// under a second and End and Ctrl+A answer in under 300 ms. Keyboard, Shift ranges, Ctrl+A and the table semantics
// (aria-rowcount, aria-rowindex) still cover every item, rendered or not.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const COUNT = 5000;
const name = (i: number) => `f-${String(i + 1).padStart(4, '0')}.txt`;
const row = (page: Page, i: number) => page.locator(`tbody tr[aria-rowindex="${i + 2}"]`);
const tile = (page: Page, name: string) => page.locator('.gallery-tile', { has: page.locator('.gallery-name', { hasText: name }) });

const BIG = 'big';

/** Creates `/<dir>/big` with COUNT empty files through the API, a few dozen requests at a time. */
async function setup(page: Page, dir: string) {
  await page.goto('/home');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  for (const p of [`/${dir}`, `/${dir}/${BIG}`]) {
    expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: p } })).status()).toBe(201);
  }
  const put = async (i: number) => {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${BIG}/${name(i)}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.alloc(0) });
    expect(r.status(), await r.text()).toBeLessThan(300);
  };
  const next = { i: 0 };
  await Promise.all(Array.from({ length: 32 }, async () => { while (next.i < COUNT) await put(next.i++); }));
}

/** Opens `/<dir>/big` from its parent with a click, as a member would; answers the milliseconds until its first row shows. */
async function openTimed(page: Page, dir: string): Promise<number> {
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  const link = page.locator('tbody tr .name').getByRole('button', { name: BIG, exact: true });
  await expect(link).toBeVisible();
  const t0 = Date.now();
  await link.click();
  await expect(page.locator('tbody tr').first().locator('.name')).toHaveText(name(0));
  return Date.now() - t0;
}
/** Asserts that `ms` stays under `budget` and notes it on the report. */
function within(label: string, ms: number, budget: number) {
  test.info().annotations.push({ type: 'timing', description: `${label}: ${ms} ms (budget ${budget} ms)` });
  expect(ms, label).toBeLessThan(budget);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('files.view', 'list'));
});

test('a folder of 5000 files shows fast, End and Ctrl+A are fast, and the table still counts every row', async ({ page }, info) => {
  test.setTimeout(180_000);
  const dir = `large-${tag(info)}`;
  await setup(page, dir);

  within('first paint', await openTimed(page, dir), 1000);
  // Only a window of rows is in the DOM; the table tells assistive technology how many there are.
  const table = page.getByRole('table');
  await expect(table).toHaveAttribute('aria-rowcount', String(COUNT + 1));
  await expect(page.locator('thead tr')).toHaveAttribute('aria-rowindex', '1');
  expect(await page.locator('tbody tr[role="row"]').count()).toBeLessThan(200);
  await expect(row(page, 0)).toContainText(name(0));

  // End: the last row is rendered, focused and in view.
  await row(page, 0).focus();
  let t0 = Date.now();
  await page.keyboard.press('End');
  await expect(row(page, COUNT - 1)).toBeFocused();
  within('End', Date.now() - t0, 300);
  await expect(row(page, COUNT - 1)).toContainText(name(COUNT - 1));
  await expect(row(page, COUNT - 1)).toBeInViewport();
  expect(await page.locator('tbody tr[role="row"]').count()).toBeLessThan(200);

  // Ctrl+A selects all 5000, rendered or not.
  t0 = Date.now();
  await page.keyboard.press('ControlOrMeta+a');
  await expect(row(page, COUNT - 1)).toHaveAttribute('aria-selected', 'true');
  within('Ctrl+A', Date.now() - t0, 300);
  await expect(page.getByRole('group', { name: /Auswahl|selection/ })).toBeVisible();

  // Arrow keys walk across the window's edge; Home goes back to the first row, which is selected too.
  await page.keyboard.press('ArrowUp');
  await expect(row(page, COUNT - 2)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(row(page, 0)).toBeFocused();
  await expect(row(page, 0)).toBeInViewport();
  await expect(row(page, 0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Space'); // deselect the first
  await expect(row(page, 0)).toHaveAttribute('aria-selected', 'false');

  // A Shift range from a row that has long left the DOM: Ctrl+click the second row (the anchor), go to the end,
  // Shift+click the last. The range replaces the selection.
  await row(page, 1).locator('td.num.size').click({ modifiers: ['ControlOrMeta'] });
  await expect(row(page, 1)).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('End');
  await row(page, COUNT - 1).locator('td.num.size').click({ modifiers: ['Shift'] });
  await expect(row(page, COUNT - 1)).toHaveAttribute('aria-selected', 'true');
  await row(page, COUNT - 1).focus();
  await page.keyboard.press('Home');
  await expect(row(page, 0)).toHaveAttribute('aria-selected', 'false');
  await expect(row(page, 1)).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 2)).toHaveAttribute('aria-selected', 'true');

  // Scrolling with the wheel renders the rows that come into view.
  await page.mouse.wheel(0, 20_000);
  await expect.poll(() => page.locator('tbody tr[role="row"]').evaluateAll((rs) => rs.some((r) => {
    const b = r.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight && Number(r.getAttribute('aria-rowindex')) > 100;
  }))).toBe(true);
});

test('the gallery of 5000 files shows fast and End reaches the last tile', async ({ page }, info) => {
  test.setTimeout(180_000);
  const dir = `large-gallery-${tag(info)}`;
  await setup(page, dir);
  await openTimed(page, dir);

  const t0 = Date.now();
  await page.getByRole('button', { name: /^(Galerie|Gallery)$/ }).click();
  await expect(tile(page, name(0))).toBeVisible();
  within('gallery', Date.now() - t0, 1000);
  expect(await page.locator('.gallery-tile').count()).toBeLessThan(500);

  await tile(page, name(0)).focus();
  let t1 = Date.now();
  await page.keyboard.press('End');
  await expect(tile(page, name(COUNT - 1))).toBeFocused();
  within('gallery End', Date.now() - t1, 300);
  await expect(tile(page, name(COUNT - 1))).toBeInViewport();
  expect(await page.locator('.gallery-tile').count()).toBeLessThan(500);

  // Arrows across rows, then Home back to the first tile.
  await page.keyboard.press('ArrowLeft');
  await expect(tile(page, name(COUNT - 2))).toBeFocused();
  t1 = Date.now();
  await page.keyboard.press('Home');
  await expect(tile(page, name(0))).toBeFocused();
  within('gallery Home', Date.now() - t1, 300);
  await expect(tile(page, name(0))).toBeInViewport();
});
