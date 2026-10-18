import { expect, test, type Page, type TestInfo } from '@playwright/test';

// #315: in English a size below a kilobyte says "bytes" with the count ("25 bytes"), not CLDR's short "25 byte".
// Runs as `testuser`; sets English for itself and resets the language afterwards.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;

async function headers(page: Page) {
  const me = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin };
}
async function putLocale(page: Page, locale: 'en' | null) {
  const r = await page.request.put('/api/v1/settings', { data: { locale, theme: 'system' }, headers: await headers(page) });
  expect(r.status(), await r.text()).toBe(200);
}

test.afterEach(async ({ page }) => { await putLocale(page, null); });

test('en: the list row of a 25-byte file says "25 bytes"', async ({ page }, info) => {
  const dir = `bytes-${tag(info)}`;
  await page.goto('/home');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
  const h = await headers(page);
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers: h, data: { path: `/${dir}` } })).status()).toBe(201);
  const put = (name: string, text: string) => page.request.put(
    `/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=replace`,
    { headers: { ...h, 'content-type': 'application/octet-stream' }, data: Buffer.from(text) });
  expect((await put('notes.txt', 'twenty-five bytes of text')).status()).toBeLessThan(300);
  expect((await put('one.txt', 'x')).status()).toBeLessThan(300);
  await putLocale(page, 'en');
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  const row = (name: string) => page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
  await expect(row('notes.txt').locator('.size')).toHaveText(/^25\sbytes$/);
  await expect(row('one.txt').locator('.size')).toHaveText(/^1\sbyte$/);
});
