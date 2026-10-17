import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

// #247: the copy review as the member reads it. A single item is "Ein Element"/"One item", never "1" without a noun;
// the settings speak without jargon; English has no quota. Runs as `testuser` (admin) in both projects; every test sets
// the language it expects and resets it afterwards.
type Settings = { locale: 'de-du' | 'de-sie' | 'en' | null; theme: 'light' | 'dark' | 'system' };
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });

async function headers(page: Page) {
  const me = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin };
}
async function putSettings(page: Page, s: Settings) {
  const r = await page.request.put('/api/v1/settings', { data: s, headers: await headers(page) });
  expect(r.status(), await r.text()).toBe(200);
}
// Every folder of this spec lives under one parent: by the end of a full run the home root is long, and only a window
// of it is rendered (#225).
const PARENT = 'wortlaut-247';
async function folderWith(page: Page, dir: string, files: string[]) {
  const h = await headers(page);
  expect([201, 409]).toContain((await page.request.post('/api/v1/sources/home/mkdir', { data: { path: `/${PARENT}` }, headers: h })).status());
  expect((await page.request.post('/api/v1/sources/home/mkdir', { data: { path: `/${dir}` }, headers: h })).status()).toBe(201);
  for (const f of files) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${f}`)}&onCollision=fail`,
      { headers: { ...h, 'content-type': 'application/octet-stream' }, data: Buffer.from('x') });
    expect(r.status(), await r.text()).toBe(201);
  }
}
async function menu(page: Page, name: string, label: RegExp, item: string) {
  await row(page, name).getByRole('button', { name: label }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: item, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
});
test.afterEach(async ({ page }) => { await putSettings(page, { locale: null, theme: 'system' }); });

const cases = [
  { locale: 'de-du', actions: /^Aktionen für /, cut: 'Verschieben', trash: 'In den Papierkorb',
    marked: /^Ein Element zum Verschieben vorgemerkt\. Öffne den Zielordner/, trashed: 'Ein Element in den Papierkorb verschoben' },
  { locale: 'de-sie', actions: /^Aktionen für /, cut: 'Verschieben', trash: 'In den Papierkorb',
    marked: /^Ein Element zum Verschieben vorgemerkt\. Öffnen Sie den Zielordner/, trashed: 'Ein Element in den Papierkorb verschoben' },
  { locale: 'en', actions: /^Actions for /, cut: 'Move', trash: 'Move to trash',
    marked: /^One item ready to move\. Open the target folder/, trashed: 'One item moved to the trash' },
] as const;

for (const c of cases) {
  test(`${c.locale}: one marked or trashed item is named as one item (C4)`, async ({ page }, info) => {
    const dir = `${PARENT}/${c.locale}-${tag(info)}`;
    await folderWith(page, dir, ['a.txt', 'b.txt']);
    await putSettings(page, { locale: c.locale, theme: 'light' });
    await page.goto(`/home/${dir}`);
    await expect(row(page, 'a.txt')).toBeVisible();

    await menu(page, 'a.txt', c.actions, c.cut);
    await expect(page.getByRole('status').filter({ hasText: c.marked })).toBeVisible();
    await expect(page.getByText(/^1 (zum|ready)/)).toHaveCount(0);

    await menu(page, 'b.txt', c.actions, c.trash);
    await expect(row(page, 'b.txt')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: c.trashed })).toBeVisible();
  });
}

test('de-du: the settings speak without jargon and keep the device wording natural (C3, C6)', async ({ page }) => {
  await putSettings(page, { locale: 'de-du', theme: 'light' });
  await page.goto('/settings');
  await expect(page.getByText(/im Finder, im Windows-Explorer oder mit anderen Programmen\./)).toBeVisible();
  await expect(page.getByText(/davfs2|rclone/)).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Wie auf dem Gerät' })).toBeVisible();
});

test('en: members have a storage limit, never a quota (C3, C7)', async ({ page }) => {
  await putSettings(page, { locale: 'en', theme: 'light' });
  await page.goto('/members');
  await expect(page.getByText(/^Everyone who has signed in to “Files” at least once\. A storage limit /)).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Storage limit', exact: true })).toBeAttached();
  await expect(page.getByText(/\bquota\b/i)).toHaveCount(0);
  await page.goto('/storage');
  await expect(page.locator('.storage-figures').first()).toBeVisible();
  await expect(page.getByText(/\bquota\b/i)).toHaveCount(0);
});
