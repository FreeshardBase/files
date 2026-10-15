import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { openPlaces } from './places.ts';

// #159: language (Deutsch Du / Deutsch Sie / English) and theme (light / dark / system) on the settings page. The choice
// is stored on the server, so it follows the member to another device. Both projects share one server and one
// `testuser`; every test starts from a known choice and takes it back at its end.

type Settings = { locale: 'de-du' | 'de-sie' | 'en' | null; theme: 'light' | 'dark' | 'system' };

async function putSettings(page: Page, s: Settings) {
  const me = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  const r = await page.request.put('/api/v1/settings', { data: s,
    headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin } });
  expect(r.status(), await r.text()).toBe(200);
}

async function putFile(page: Page, path: string, text: string) {
  const me = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=replace`, {
    data: Buffer.from(text), headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin,
      'content-type': 'application/octet-stream' } });
  expect(r.status(), await r.text()).toBeLessThan(300);
}

/** A second browser context of the same member, with the project's device and a German browser. */
async function otherDevice(browser: Browser, info: TestInfo, baseURL: string, path: string): Promise<Page> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const ctx = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, locale: 'de-DE' });
  const p = await ctx.newPage();
  await p.goto(`/auth/login?login_hint=testuser&returnTo=${encodeURIComponent(path)}`);
  return p;
}

const radio = (page: Page, name: string | RegExp) => page.getByRole('radio', { name });
const settingsHeading = (page: Page) => page.getByRole('heading', { level: 1 });
const sieText = /Binden Sie Ihren Speicher/;
const enDate = /^\d{1,2} [A-Z][a-z]{2,3} \d{4}, \d{2}:\d{2}$/;
const deDate = /^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/;
const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const LIGHT_BG = 'rgb(246, 244, 239)';
const DARK_BG = 'rgb(22, 20, 15)';

test.beforeEach(async ({ page }) => {
  await page.goto('/home');
  // Signed in only once the shell shows the sidebar; before that the login redirect may still replace the session.
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeVisible();
  await putSettings(page, { locale: 'de-du', theme: 'light' });
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await putSettings(page, { locale: null, theme: 'system' });
});

test('switching to English and to Deutsch (Sie) changes texts and dates at once and on another device', async ({ page, browser, baseURL }, info) => {
  const folder = `/Sprache-${info.project.name}`;
  await putFile(page, `${folder}/note.txt`, 'hello');
  const other = await otherDevice(browser, info, baseURL!, `/home${folder}`);
  await expect(other.locator('tr', { hasText: 'note.txt' }).locator('td.date')).toHaveText(deDate);

  await page.goto('/settings');
  await expect(settingsHeading(page)).toHaveText('Einstellungen');
  await expect(radio(page, 'Deutsch (Du)')).toBeChecked();
  await radio(page, 'English').check();
  // At once, without a reload: the page, the sidebar and <html lang>.
  await expect(settingsHeading(page)).toHaveText('Settings');
  await openPlaces(page);
  await expect(page.getByRole('navigation', { name: 'Places' }).getByRole('link', { name: 'My storage' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('status').filter({ hasText: 'Settings saved' })).toBeVisible();
  await page.goto(`/home${folder}`);
  await expect(page.locator('tr', { hasText: 'note.txt' }).locator('td.date')).toHaveText(enDate);

  // The other device (a German browser) follows the stored choice after a reload.
  await other.reload();
  await openPlaces(other);
  await expect(other.getByRole('navigation', { name: 'Places' }).getByRole('link', { name: 'My storage' })).toBeVisible();
  await expect(other.locator('tr', { hasText: 'note.txt' }).locator('td.date')).toHaveText(enDate);

  await page.goto('/settings');
  await radio(page, 'Deutsch (Sie)').check();
  await expect(settingsHeading(page)).toHaveText('Einstellungen');
  await expect(page.getByText(sieText)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.reload();
  await expect(page.getByText(sieText)).toBeVisible();
  await expect(radio(page, 'Deutsch (Sie)')).toBeChecked();

  await other.goto('/settings');
  await expect(other.getByText(sieText)).toBeVisible();
  await other.goto(`/home${folder}`);
  await expect(other.locator('tr', { hasText: 'note.txt' }).locator('td.date')).toHaveText(deDate);
  await other.context().close();
});

test('the theme switch changes the tokens at once and on another device; "system" follows the device', async ({ page, browser, baseURL }, info) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/settings');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await bg(page)).toBe(LIGHT_BG);

  await radio(page, 'Dunkel').check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => bg(page)).toBe(DARK_BG);
  await page.reload();
  await expect(radio(page, 'Dunkel')).toBeChecked();
  expect(await bg(page)).toBe(DARK_BG);

  const other = await otherDevice(browser, info, baseURL!, '/settings');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => bg(other)).toBe(DARK_BG);
  await other.context().close();

  // "System": the device's preference, also when it changes while the page is open.
  await radio(page, 'Wie das Gerät').check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => bg(page)).toBe(DARK_BG);

  await radio(page, 'Hell').check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => bg(page)).toBe(LIGHT_BG);
});

test('a failing save shows the error and keeps the previous choice (#122)', async ({ page }) => {
  await page.goto('/settings');
  await page.route('**/api/v1/settings', (route) => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL' }) })
    : route.fallback());

  await radio(page, 'English').check();
  await expect(page.getByRole('alert').filter({ hasText: 'Etwas ist schiefgelaufen. Versuch es später noch einmal.' })).toBeVisible();
  await expect(radio(page, 'Deutsch (Du)')).toBeChecked();
  await expect(radio(page, 'English')).not.toBeChecked();
  await expect(settingsHeading(page)).toHaveText('Einstellungen');

  await radio(page, 'Dunkel').check();
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(radio(page, 'Hell')).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // Nothing reached the server: a reload shows the old choice.
  await page.unrouteAll();
  await page.reload();
  await expect(radio(page, 'Deutsch (Du)')).toBeChecked();
  await expect(radio(page, 'Hell')).toBeChecked();
});

test('the language "automatic" goes back to the browser language', async ({ page }) => {
  await page.goto('/settings');
  await radio(page, /^Automatisch/).check();
  // The project's browser is English (Playwright's default locale en-US).
  await expect(settingsHeading(page)).toHaveText('Settings');
  await page.reload();
  await expect(radio(page, /^Automatic/)).toBeChecked();
});

// Screenshot baselines of the folder view in both themes and all three languages. The modification dates change with
// every run and are masked; everything else in the folder is fixed.
for (const theme of ['light', 'dark'] as const) {
  for (const locale of ['de-du', 'de-sie', 'en'] as const) {
    test(`folder view screenshot: ${theme}, ${locale}`, async ({ page }) => {
      await putFile(page, '/Screens/Report.txt', 'quarterly numbers\n');
      await putFile(page, '/Screens/Plan.md', '# Plan\n\nsteps\n');
      await putSettings(page, { locale, theme });
      await page.goto('/home/Screens');
      const view = page.locator('section.folder');
      await expect(view.locator('tr', { hasText: 'Report.txt' })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect(view).toHaveScreenshot(`folder-${theme}-${locale}.png`, { mask: [view.locator('td.date')], animations: 'disabled', caret: 'hide' });
    });
  }
}
