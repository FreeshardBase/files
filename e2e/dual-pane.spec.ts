import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openPlaces } from './places.ts';

// #218: two folder panes side by side, a setting of each member, off by default. Each pane has its own place and
// selection; the focused one takes every action. Items move and copy between the panes by dragging, by "Copy/Move to
// other pane" and by F5/F6. Runs against the cloud server (e2e/cloudServer.ts), whose Dropbox holds
// /Reports/Q3 Übersicht.txt. Both projects share the server and `testuser`: every test turns the setting off again.
test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

const left = (page: Page) => page.getByRole('region', { name: /^(Linker Bereich|Left pane)$/ });
const right = (page: Page) => page.getByRole('region', { name: /^(Rechter Bereich|Right pane)$/ });
const row = (scope: Locator, name: string) => scope.locator('tbody tr', { has: scope.page().locator('.name').getByText(name, { exact: true }) });
const wideOnly = (info: TestInfo) => test.skip(info.project.name !== 'desktop-chrome', 'two panes need a wide screen');

async function headersOf(page: Page) {
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
}
async function putLayout(page: Page, layout: { dualPane: boolean; tabs: boolean }) {
  const r = await page.request.put('/api/v1/settings/layout', { data: layout, headers: await headersOf(page) });
  expect(r.status(), await r.text()).toBe(200);
}
/** Signs in as testuser and removes connections and finished transfers an earlier test or project left. */
async function signedIn(page: Page) {
  await page.goto('/auth/login?returnTo=%2Fconnections');
  await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
  const headers = await headersOf(page);
  for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
    expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
  }
  expect((await page.request.post('/api/v1/transfers/clear', { headers })).status()).toBe(204);
  return headers;
}
async function folderWith(page: Page, dir: string, files: string[]) {
  const headers = await headersOf(page);
  await page.request.post('/api/v1/sources/home/delete', { headers, data: { paths: [dir] } }); // an earlier run's
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: dir } })).status()).toBe(201);
  for (const f of files) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`${dir}/${f}`)}&onCollision=fail`, {
      data: Buffer.from(f), headers: { ...headers, 'content-type': 'application/octet-stream' } });
    expect(r.status(), await r.text()).toBeLessThan(300);
  }
}

// A test skipped on the phone never signed in.
test.afterEach(async ({ page }) => { if (page.url().startsWith('http')) await putLayout(page, { dualPane: false, tabs: false }); });

test('the setting is off by default; on, two panes show on a wide screen and one on a narrow one; off again, one', async ({ page }, info) => {
  await signedIn(page);
  await putLayout(page, { dualPane: false, tabs: false });
  await page.goto('/home');
  await expect(page.locator('section.folder')).toHaveCount(1);
  await expect(left(page)).toHaveCount(0);

  await openPlaces(page);
  await page.getByRole('navigation', { name: /Orte|Places/ }).getByRole('link', { name: /Einstellungen|Settings/ }).click();
  const box = page.getByRole('checkbox', { name: /^(Zwei Bereiche nebeneinander|Two panes side by side)$/ });
  await expect(box).not.toBeChecked();
  await box.check();
  await expect(page.getByRole('status').filter({ hasText: /Einstellungen gespeichert|Settings saved/ })).toBeVisible();
  // Stored on the server, for every device.
  expect((await (await page.request.get('/api/v1/settings/layout')).json()).dualPane).toBe(true);

  await page.goto('/home');
  if (info.project.name === 'desktop-chrome') {
    await expect(left(page)).toBeVisible();
    await expect(right(page)).toBeVisible();
    await expect(page.locator('section.folder')).toHaveCount(2);
    // A narrow window ignores the setting: one pane, as without it.
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(left(page)).toHaveCount(0);
    await expect(page.locator('section.folder')).toHaveCount(1);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(right(page)).toBeVisible();
  } else {
    await expect(page.locator('.breadcrumbs')).toBeVisible();
    await expect(left(page)).toHaveCount(0);
    await expect(page.locator('section.folder')).toHaveCount(1);
  }

  await openPlaces(page);
  await page.getByRole('navigation', { name: /Orte|Places/ }).getByRole('link', { name: /Einstellungen|Settings/ }).click();
  await box.uncheck();
  await expect(page.getByRole('status').filter({ hasText: /Einstellungen gespeichert|Settings saved/ })).toBeVisible();
  expect((await (await page.request.get('/api/v1/settings/layout')).json()).dualPane).toBe(false);
  await page.goto('/home');
  await expect(page.locator('.breadcrumbs')).toBeVisible();
  await expect(left(page)).toHaveCount(0);
  await expect(page.locator('section.folder')).toHaveCount(1);
});

test('copy a Dropbox file into a home folder by dragging it to the other pane', async ({ page }, info) => {
  wideOnly(info);
  await signedIn(page);
  const dir = `/dual-drag-${info.project.name}`;
  await folderWith(page, dir, []);
  await putLayout(page, { dualPane: true, tabs: false });

  // The left pane: Dropbox, connected from the cloud accounts page.
  await page.getByRole('button', { name: /Dropbox verbinden|Connect Dropbox/ }).click();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  await expect(left(page)).toHaveAttribute('aria-current', 'true');
  await row(left(page), 'Reports').getByRole('button', { name: 'Reports', exact: true }).click();
  await expect(row(left(page), 'Q3 Übersicht.txt')).toBeVisible();
  const dropbox = page.url();

  // The right pane: the home, in this project's folder. Acting in it focuses it and puts its place in the address.
  await row(right(page), dir.slice(1)).getByRole('button', { name: dir.slice(1), exact: true }).click();
  await expect(right(page)).toHaveAttribute('aria-current', 'true');
  await expect(left(page)).not.toHaveAttribute('aria-current', 'true');
  await expect(page).toHaveURL(new RegExp(`/home${dir}$`));
  await expect(right(page).locator('.empty-state')).toBeVisible();

  // Dragged across: between two sources it is a copy, a transfer job like a paste.
  await row(left(page), 'Q3 Übersicht.txt').locator('td.size').dragTo(right(page).locator('.folder-content'));
  await expect(row(right(page), 'Q3 Übersicht.txt')).toBeVisible();
  await expect(row(left(page), 'Q3 Übersicht.txt')).toBeVisible(); // still in the Dropbox
  const copied = await page.request.get(`/api/v1/sources/home/content?path=${encodeURIComponent(`${dir}/Q3 Übersicht.txt`)}`);
  expect(await copied.text()).toBe('third quarter, from dropbox');
  expect(dropbox).toMatch(/\/conn:[0-9a-f]{32}\/Reports$/);
});

test('an action in the right pane leaves the left selection alone; F5 copies, Tab switches panes', async ({ page }, info) => {
  wideOnly(info);
  await signedIn(page);
  const a = `/dual-a-${info.project.name}`; const b = `/dual-b-${info.project.name}`;
  await folderWith(page, a, ['left one.txt', 'left two.txt']);
  await folderWith(page, b, ['right one.txt', 'right two.txt']);
  await putLayout(page, { dualPane: true, tabs: false });

  await page.goto(`/home${a}`);
  await expect(row(left(page), 'left one.txt')).toBeVisible();
  await row(right(page), b.slice(1)).getByRole('button', { name: b.slice(1), exact: true }).click();
  await expect(row(right(page), 'right one.txt')).toBeVisible();

  // One item selected on the left.
  await row(left(page), 'left one.txt').getByRole('checkbox').check();
  await expect(left(page).locator('.selection-count')).toHaveText(/1 (ausgewählt|selected)/);

  // On the right: select all and copy into the left pane's folder with F5.
  await row(right(page), 'right one.txt').locator('td.size').click();
  await page.keyboard.press('Control+a');
  await expect(right(page).locator('.selection-count')).toHaveText(/2 (ausgewählt|selected)/);
  await expect(right(page)).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('F5');
  await expect(row(left(page), 'right one.txt')).toBeVisible();
  await expect(row(left(page), 'right two.txt')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/home${b}$`)); // F5 copied instead of reloading the page

  // The left selection is untouched: still the one item, and only it.
  await expect(left(page).locator('.selection-count')).toHaveText(/1 (ausgewählt|selected)/);
  await expect(row(left(page), 'left one.txt')).toHaveAttribute('aria-selected', 'true');
  await expect(row(left(page), 'right one.txt')).toHaveAttribute('aria-selected', 'false');
  await expect(row(right(page), 'right one.txt')).toHaveAttribute('aria-selected', 'true');

  // "Move to other pane" in the right pane's bar moves its selection over; the left selection still stands.
  await right(page).getByRole('button', { name: /^(In den anderen Bereich verschieben|Move to other pane)$/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); // both names are taken on the left now
  await page.getByRole('dialog').getByRole('checkbox').check(); // for all
  await page.getByRole('dialog').getByRole('button', { name: /^(Überspringen|Skip)$/ }).click();
  await expect(left(page).locator('.selection-count')).toHaveText(/1 (ausgewählt|selected)/);

  // Tab from the right list goes to the left pane, which then takes the actions.
  await row(right(page), 'right one.txt').focus();
  await page.keyboard.press('Tab');
  await expect(left(page)).toHaveAttribute('aria-current', 'true');
  await expect(left(page).locator('tbody tr:focus')).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`/home${a}$`));
});

// #389: with two panes the transfer panel above them spans the workspace, so its right edge lines up with the right
// pane's; with one pane it keeps the 960 px column.
test('#389: with two panes the transfer panel ends where the right pane ends', async ({ page }, info) => {
  wideOnly(info);
  await signedIn(page);
  const dir = '/panel389'; // short: a wrapped name takes the click between its lines (only desktop-chrome runs this)
  await folderWith(page, dir, []);
  await putLayout(page, { dualPane: true, tabs: false });

  // Dropbox on the left, the home folder on the right; a drag across the sources copies, a transfer job.
  await page.getByRole('button', { name: /Dropbox verbinden|Connect Dropbox/ }).click();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  await row(left(page), 'Reports').getByRole('button', { name: 'Reports', exact: true }).click();
  await expect(row(left(page), 'Q3 Übersicht.txt')).toBeVisible();
  await row(right(page), dir.slice(1)).getByRole('button', { name: dir.slice(1), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/home${dir}$`));
  await expect(right(page).locator('.empty-state')).toBeVisible();
  await row(left(page), 'Q3 Übersicht.txt').locator('td.size').dragTo(right(page).locator('.folder-content'));
  await expect(row(right(page), 'Q3 Übersicht.txt')).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  const panel = page.getByTestId('transfer-panel');
  await expect(panel).toBeVisible();
  const panelBox = (await panel.boundingBox())!;
  const paneBox = (await right(page).boundingBox())!;
  expect(Math.abs(panelBox.x + panelBox.width - (paneBox.x + paneBox.width))).toBeLessThan(1);
});
