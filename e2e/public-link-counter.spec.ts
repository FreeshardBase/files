import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';

// #232: the public link page counts down after every download and preview, says once that no downloads are left and
// then offers none, and mentions the limit only when the link has one. Revoking a link asks first.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const row = (page: Page, name: string) => page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const COUNT_NOTE = 'Every download and every preview counts towards the limit of this link.';
const NONE_LEFT = 'This link has no downloads left.';

/** `/<dir>/<name>` with `text`, and a public link to it with `maxDownloads`; answers the link's address. */
async function linkTo(page: Page, dir: string, name: string, text: string, maxDownloads: number | null, label = 'Visitors') {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  const path = `/${dir}/${name}`;
  const put = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=fail`,
    { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(text) });
  expect(put.status()).toBe(201);
  const l = await page.request.post('/api/v1/links', { headers, data: { source: 'home', path, label, maxDownloads } });
  expect(l.status()).toBe(201);
  return `/s/${(await l.json()).token}`;
}

async function visitor(browser: Browser, info: TestInfo, baseURL: string): Promise<Page> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const ctx = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, locale: 'en-US',
    acceptDownloads: true });
  return ctx.newPage();
}
const left = (v: Page) => v.locator('.link-facts dt', { hasText: 'Downloads left' }).locator('xpath=following-sibling::dd[1]');

test('the counter goes down with every download and preview; at the limit one message and no download', async ({ page, browser, baseURL }, info) => {
  const address = await linkTo(page, `link-count-${tag(info)}`, 'notes.txt', 'hello', 2);
  const v = await visitor(browser, info, baseURL!);
  await v.goto(address);
  await expect(left(v)).toHaveText('2');
  await expect(v.getByText(COUNT_NOTE)).toBeVisible();

  const [download] = await Promise.all([v.waitForEvent('download'), v.getByRole('link', { name: 'Download' }).click()]);
  expect(download.suggestedFilename()).toBe('notes.txt');
  await expect(left(v)).toHaveText('1');

  const [popup] = await Promise.all([v.waitForEvent('popup'), v.getByRole('link', { name: 'Open preview' }).click()]);
  await expect(popup.locator('body')).toHaveText('hello');
  await popup.close();
  await expect(left(v)).toHaveText('0');
  await expect(v.getByText(NONE_LEFT)).toHaveCount(1);
  await expect(v.getByRole('link', { name: 'Download' })).toHaveCount(0);
  await expect(v.getByRole('link', { name: 'Open preview' })).toHaveCount(0);
  await expect(v.getByText(COUNT_NOTE)).toHaveCount(0);

  // A download the server refuses (an old tab, a copied address) comes back to the page with the same one message.
  await v.goto(`${address}/content?path=%2F`);
  await expect(v).toHaveURL(/\?error=DOWNLOAD_LIMIT_REACHED$/);
  await expect(v.getByTestId('link-name')).toHaveText('notes.txt');
  await expect(v.getByText(NONE_LEFT)).toHaveCount(1);
  await expect(v.getByRole('link', { name: 'Download' })).toHaveCount(0);
  await v.context().close();
});

test('a link without a limit says nothing about a limit', async ({ page, browser, baseURL }, info) => {
  const address = await linkTo(page, `link-nolimit-${tag(info)}`, 'free.txt', 'open to all', null);
  const v = await visitor(browser, info, baseURL!);
  await v.goto(address);
  await expect(v.getByRole('link', { name: 'Download' })).toBeVisible();
  await expect(v.getByText('Downloads left')).toHaveCount(0);
  await expect(v.getByText(COUNT_NOTE)).toHaveCount(0);
  await v.context().close();
});

test('revoking a public link asks first; Cancel keeps it, confirming revokes it', async ({ page }, info) => {
  const dir = `link-revoke-${tag(info)}`;
  await linkTo(page, dir, 'plan.txt', 'draft', null, 'Builder');
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await row(page, 'plan.txt').getByRole('button', { name: /(Aktionen für|Actions for) plan\.txt/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /^(Freigeben|Share)$/ }).click();
  const share = page.getByRole('dialog', { name: /freigeben|Share/ });
  const links = share.getByRole('list', { name: /Öffentliche Links|Public links/ });
  await expect(links).toContainText('Builder');

  await share.getByRole('button', { name: /(Builder widerrufen|Revoke Builder)/ }).click();
  const confirm = page.getByRole('dialog', { name: /Builder/ }).filter({ hasNot: links });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(/nicht mehr|no longer/);
  await expect(confirm.getByRole('button', { name: /^(Abbrechen|Cancel)$/ })).toBeFocused();
  await confirm.getByRole('button', { name: /^(Abbrechen|Cancel)$/ }).click();
  await expect(confirm).toHaveCount(0);
  await expect(links).toContainText('Builder');
  await expect(share.getByRole('button', { name: /(Builder widerrufen|Revoke Builder)/ })).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(confirm).toBeVisible();
  // Esc closes only the question, never the share dialog behind it.
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(share).toBeVisible();
  await share.getByRole('button', { name: /(Builder widerrufen|Revoke Builder)/ }).click();
  await confirm.getByRole('button', { name: /^(Widerrufen|Revoke)$/ }).click();
  await expect(confirm).toHaveCount(0);
  await expect(links).toHaveCount(0);
  await expect(share).toContainText(/Noch kein öffentlicher Link|No public link yet/);
  await expect(share.getByRole('button', { name: /Neuer öffentlicher Link|New public link/ })).toBeFocused();
});
