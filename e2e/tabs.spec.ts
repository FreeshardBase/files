import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openPlaces, places } from './places.ts';

// #219: browser-style tabs, a setting of each member, off by default. Each tab has its own place, selection, scroll and
// view; the tabs come back on this device after a reload; the last tab cannot be closed. Runs against the cloud server
// (e2e/cloudServer.ts) for two cloud sources: its Dropbox (/Reports/Q3 Übersicht.txt) and the generic Fake Cloud
// (/report.txt). Both projects share the server and `testuser`: every test turns the setting off again.
test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

// Hidden tabs stay in the page; only the tab in front is visible.
const shown = (page: Page) => page.locator('.tab-panel:visible');
const row = (scope: Locator, name: string) => scope.locator('tbody tr', { has: scope.page().locator('.name').getByText(name, { exact: true }) });
const tabs = (page: Page) => page.getByRole('tablist', { name: /^(Offene Ordner|Open folders)$/ }).getByRole('tab');
const newTab = (page: Page) => page.getByRole('button', { name: /^(Neuer Tab|New tab)$/ });
const closeTab = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^(Tab „${name}“ schließen|Close tab “${name}”)$`) });

async function headersOf(page: Page) {
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
}
async function putLayout(page: Page, layout: { dualPane: boolean; tabs: boolean }) {
  const r = await page.request.put('/api/v1/settings/layout', { data: layout, headers: await headersOf(page) });
  expect(r.status(), await r.text()).toBe(200);
}
/** Signs in as testuser with a fresh Dropbox and Fake Cloud connection and a home folder of this project's. */
async function setUp(page: Page, info: TestInfo) {
  await page.goto('/auth/login?returnTo=%2Fconnections');
  await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
  const headers = await headersOf(page);
  for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
    expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
  }
  const dir = `/tabs-${info.project.name}`;
  await page.request.post('/api/v1/sources/home/delete', { headers, data: { paths: [dir] } }); // an earlier run's
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: dir } })).status()).toBe(201);
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `${dir}/inner` } })).status()).toBe(201);
  for (const f of ['one.txt', 'two.txt']) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`${dir}/${f}`)}&onCollision=fail`, {
      data: Buffer.from(f), headers: { ...headers, 'content-type': 'application/octet-stream' } });
    expect(r.status(), await r.text()).toBeLessThan(300);
  }
  for (const provider of ['Dropbox', 'Fake Cloud']) {
    await page.goto('/connections');
    await page.getByRole('button', { name: new RegExp(`${provider} verbinden|Connect ${provider}`) }).click();
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  }
  return dir.slice(1);
}

test.afterEach(async ({ page }) => { await putLayout(page, { dualPane: false, tabs: false }); });

test('three tabs in three sources keep their own place and selection; they come back after a reload', async ({ page }, info) => {
  const dir = await setUp(page, info);
  await putLayout(page, { dualPane: false, tabs: true });

  // Tab 1: the home folder, one item selected.
  await page.goto(`/home/${dir}`);
  await expect(tabs(page)).toHaveCount(1);
  await expect(closeTab(page, dir)).toHaveCount(0); // the last tab cannot be closed
  await row(shown(page), 'one.txt').getByRole('checkbox').check();
  await expect(shown(page).locator('.selection-count')).toHaveText(/1 (ausgewählt|selected)/);

  // Tab 2: Dropbox's Reports. A new tab opens at the same place, then goes elsewhere through the sidebar.
  await newTab(page).click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(shown(page).locator('.selection-count')).toHaveCount(0); // a new tab has no selection
  await (await openPlaces(page)).getByRole('link', { name: /Dropbox/ }).click();
  await row(shown(page), 'Reports').getByRole('button', { name: 'Reports', exact: true }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}\/Reports$/);
  await expect(row(shown(page), 'Q3 Übersicht.txt')).toBeVisible();
  const dropbox = new URL(page.url()).pathname;

  // Tab 3: the Fake Cloud's root.
  await newTab(page).click();
  await (await openPlaces(page)).getByRole('link', { name: /Fake Cloud/ }).click();
  await expect(row(shown(page), 'report.txt')).toBeVisible();
  const fake = new URL(page.url()).pathname;
  await expect(tabs(page)).toHaveText([dir, 'Reports', 'Fake Cloud']);

  // Back to tab 1: its place and its selection are still there; the address follows the tab in front.
  await tabs(page).nth(0).click();
  await expect(page).toHaveURL(new RegExp(`/home/${dir}$`));
  await expect(shown(page).locator('.selection-count')).toHaveText(/1 (ausgewählt|selected)/);
  await expect(row(shown(page), 'one.txt')).toHaveAttribute('aria-selected', 'true');
  await expect(row(shown(page), 'two.txt')).toHaveAttribute('aria-selected', 'false');
  await tabs(page).nth(1).click();
  await expect(page).toHaveURL(new RegExp(`${dropbox}$`));
  await expect(row(shown(page), 'Q3 Übersicht.txt')).toBeVisible();
  await expect(shown(page).locator('.selection-count')).toHaveCount(0);
  await tabs(page).nth(0).click();
  await expect(row(shown(page), 'one.txt')).toHaveAttribute('aria-selected', 'true');

  // A middle click on a folder opens it in a new tab behind the one in front.
  await row(shown(page), 'inner').getByRole('button', { name: 'inner', exact: true }).click({ button: 'middle' });
  await expect(tabs(page)).toHaveText([dir, 'inner', 'Reports', 'Fake Cloud']);
  await expect(tabs(page).nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(new RegExp(`/home/${dir}$`));

  // A reload brings the tabs back on this device, each at its place.
  await page.reload();
  await expect(tabs(page)).toHaveText([dir, 'inner', 'Reports', 'Fake Cloud']);
  await expect(tabs(page).nth(0)).toHaveAttribute('aria-selected', 'true');
  await tabs(page).nth(3).click();
  await expect(page).toHaveURL(new RegExp(`${fake}$`));
  await expect(row(shown(page), 'report.txt')).toBeVisible();

  // Closing: the tab beside takes the front; the last tab has no close button.
  for (const name of ['Fake Cloud', 'Reports', 'inner']) await closeTab(page, name).click();
  await expect(tabs(page)).toHaveText([dir]);
  await expect(page).toHaveURL(new RegExp(`/home/${dir}$`));
  await expect(closeTab(page, dir)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Tab „.*“ schließen|Close tab “.*”)$/ })).toHaveCount(0);
});

test('without the setting there are no tabs; it is turned on and off in Settings', async ({ page }, info) => {
  const dir = await setUp(page, info);
  await putLayout(page, { dualPane: false, tabs: false });
  await page.goto(`/home/${dir}`);
  await expect(row(page.locator('section.folder'), 'one.txt')).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(newTab(page)).toHaveCount(0);
  // A middle click on a folder does nothing without tabs.
  await row(page.locator('section.folder'), 'inner').getByRole('button', { name: 'inner', exact: true }).click({ button: 'middle' });
  await expect(page.getByRole('tablist')).toHaveCount(0);

  await (await openPlaces(page)).getByRole('link', { name: /Einstellungen|Settings/ }).click();
  const box = page.getByRole('checkbox', { name: /^Tabs$/ });
  await expect(box).not.toBeChecked();
  await box.check();
  await expect(page.getByRole('status').filter({ hasText: /Einstellungen gespeichert|Settings saved/ })).toBeVisible();
  expect((await (await page.request.get('/api/v1/settings/layout')).json()).tabs).toBe(true);
  await page.goBack();
  await expect(tabs(page)).toHaveText([dir]);
  await expect(places(page)).toBeAttached();

  await page.goto('/settings');
  await page.getByRole('checkbox', { name: /^Tabs$/ }).uncheck();
  await expect(page.getByRole('status').filter({ hasText: /Einstellungen gespeichert|Settings saved/ })).toBeVisible();
  await (await openPlaces(page)).getByRole('link', { name: /Mein Speicher|My storage/ }).click();
  await row(page.locator('section.folder'), dir).getByRole('button', { name: dir, exact: true }).click();
  await expect(row(page.locator('section.folder'), 'one.txt')).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);
});
