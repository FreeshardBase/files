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
