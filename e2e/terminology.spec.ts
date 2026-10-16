import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openPlaces } from './places.ts';

// #246: the German wording the UI shows. Sharing with members is "freigeben", the places list says "Zuletzt geändert",
// the app is „Dateien“, and Deutsch (Sie) asks the collision question formally. Runs as `testuser` (admin) in both
// projects; every test sets the language it expects and resets it afterwards.
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
async function mkdir(page: Page, path: string) {
  const r = await page.request.post('/api/v1/sources/home/mkdir', { data: { path }, headers: await headers(page) });
  expect(r.status(), await r.text()).toBe(201);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
});
test.afterEach(async ({ page }) => {
  await putSettings(page, { locale: null, theme: 'system' });
});

for (const locale of ['de-du', 'de-sie'] as const) {
  test(`${locale}: sharing with members is "Freigeben", and the places say "Für mich freigegeben" and "Zuletzt geändert"`, async ({ page }, info) => {
    // Its own parent folder: by the end of a full run the home folder is long and only a window of it is rendered.
    const parent = `begriffe-${locale}-${tag(info)}`;
    const dir = 'Urlaub';
    await mkdir(page, `/${parent}`);
    await mkdir(page, `/${parent}/${dir}`);
    await putSettings(page, { locale, theme: 'light' });
    await page.goto(`/home/${parent}`);
    await expect(row(page, dir)).toBeVisible();

    await row(page, dir).getByRole('button', { name: `Aktionen für ${dir}` }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Freigeben', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Teilen', exact: true })).toHaveCount(0);
    await menu.getByRole('menuitem', { name: 'Freigeben', exact: true }).click();
    const d = page.getByRole('dialog', { name: `„${dir}“ freigeben`, exact: true });
    await expect(d).toBeVisible();
    await expect(d.getByRole('button', { name: 'Freigeben', exact: true })).toBeVisible();
    // The member field has the initial focus and keeps Esc for its suggestions; from the button Esc closes the dialog.
    await d.getByRole('button', { name: 'Freigeben', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);

    const nav = await openPlaces(page);
    await expect(nav.getByRole('link', { name: 'Zuletzt geändert', exact: true })).toBeVisible();
    await nav.getByRole('link', { name: 'Für mich freigegeben', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Für mich freigegeben', level: 1 })).toBeVisible();
    await expect(page.getByText(/geteilt/i)).toHaveCount(0);
  });
}

test('the members page names the app „Dateien“ in German and “Files” in English', async ({ page }) => {
  await putSettings(page, { locale: 'de-du', theme: 'light' });
  await page.goto('/members');
  await expect(page.getByText(/^Alle, die sich schon einmal bei „Dateien“ angemeldet haben\./)).toBeVisible();
  await expect(page.getByText(/\bFiles\b/)).toHaveCount(0);
  await putSettings(page, { locale: 'en', theme: 'light' });
  await page.reload();
  await expect(page.getByText(/^Everyone who has signed in to “Files” before\./)).toBeVisible();
});

test('de-sie: the collision dialog asks "Was möchten Sie tun?" under "Name schon vergeben"', async ({ page }, info) => {
  const dir = `kollision-${tag(info)}`;
  const name = 'notes.txt';
  await mkdir(page, `/${dir}`);
  await putSettings(page, { locale: 'de-sie', theme: 'light' });
  await page.goto(`/home/${dir}`);
  await expect(page.getByRole('navigation', { name: 'Pfad' })).toBeVisible();
  const file = (text: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  await page.getByTestId('upload-input').setInputFiles([file('old')]);
  await expect(page.getByRole('status')).toContainText('1 von 1');
  await expect(row(page, name)).toBeVisible();
  await page.getByTestId('upload-input').setInputFiles([file('new')]);
  const d = page.getByRole('dialog', { name: 'Name schon vergeben', exact: true });
  await expect(d).toBeVisible();
  await expect(d).toContainText(`„${name}“ gibt es hier schon. Was möchten Sie tun?`);
  await page.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
});
