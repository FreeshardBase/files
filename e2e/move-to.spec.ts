import { expect, test, type Page } from '@playwright/test';

// #339: "Move to…" / "Copy to…" open a folder picker across all sources: the home, each cloud connection and the shares
// the member may change. Within one source the items move or copy directly; into another source a transfer job runs.
// The current folder and the selected folders cannot be chosen. Runs against the cloud server (e2e/cloudServer.ts), whose
// Google Drive holds /Photos. Both projects share the server: each test works in folders named after its project.
test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

const row = (page: Page, name: string) => page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const panel = (page: Page) => page.getByRole('region', { name: /^(Übertragungen|Transfers)$/ });
const label = (mode: 'move' | 'copy') => (mode === 'move' ? /^(Verschieben nach …|Move to…)$/ : /^(Kopieren nach …|Copy to…)$/);
const picker = (page: Page, mode: 'move' | 'copy') => page.getByRole('dialog', { name: label(mode) });
const menuItem = (page: Page, mode: 'move' | 'copy') => page.getByRole('menu').getByRole('menuitem', { name: label(mode) });

/** Signs in as testuser, removes connections and finished transfers an earlier test or project left. */
async function signedIn(page: Page) {
  await page.goto('/auth/login?returnTo=%2Fconnections');
  await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
    expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
  }
  expect((await page.request.post('/api/v1/transfers/clear', { headers })).status()).toBe(204);
  await page.evaluate(() => localStorage.clear()); // the remembered target of an earlier run
  await page.reload();
  return headers;
}
async function freshDir(page: Page, headers: Record<string, string>, dir: string, files: string[], folders: string[] = []) {
  await page.request.post('/api/v1/sources/home/delete', { headers, data: { paths: [dir] } }); // an earlier run's
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: dir } })).status()).toBe(201);
  for (const f of folders) expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `${dir}/${f}` } })).status()).toBe(201);
  for (const f of files) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`${dir}/${f}`)}&onCollision=fail`, {
      data: Buffer.from(f), headers: { ...headers, 'content-type': 'application/octet-stream' } });
    expect(r.status(), await r.text()).toBeLessThan(300);
  }
}
const names = async (page: Page, source: string, path: string) =>
  ((await (await page.request.get(`/api/v1/sources/${encodeURIComponent(source)}/list?path=${encodeURIComponent(path)}`)).json())
    .entries as { name: string }[]).map((e) => e.name);

test('move a file from the home into a Google Drive subfolder through the picker', async ({ page }, info) => {
  const headers = await signedIn(page);
  await page.getByRole('button', { name: /Google Drive verbinden|Connect Google Drive/ }).click();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  const drive = decodeURIComponent(new URL(page.url()).pathname.split('/')[1]!);
  const dir = `/pick-${info.project.name}`;
  const file = `moved-${info.project.name}.txt`;
  await freshDir(page, headers, dir, [file]);

  await page.goto(`/home${dir}`);
  await row(page, file).getByRole('button', { name: new RegExp(`(Aktionen für|Actions for) ${file.replace('.', '\\.')}`) }).click();
  await menuItem(page, 'move').click();
  const dialog = picker(page, 'move');
  await expect(dialog).toBeVisible();
  // The top level lists the sources; the Drive connection is one of them.
  await expect(dialog.getByRole('button', { name: /^(Mein Speicher|My storage)$/ })).toBeVisible();
  await dialog.getByRole('button', { name: /Google Drive/ }).click();
  await dialog.getByRole('button', { name: 'Photos', exact: true }).click();
  await expect(dialog.getByRole('navigation')).toContainText('Photos');
  // Tap targets on the phone are at least 44 px high.
  if (info.project.name === 'mobile-chrome') {
    expect((await dialog.getByRole('button', { name: /^(Hierher verschieben|Move here)$/ }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await dialog.getByRole('button', { name: /^(Hierher verschieben|Move here)$/ }).click();
  await expect(dialog).toHaveCount(0);

  await expect(panel(page)).toContainText(/Fertig|Done/);
  await expect(row(page, file)).toHaveCount(0);
  expect(await names(page, drive, '/Photos')).toContain(file);
  expect(await names(page, 'home', dir)).not.toContain(file);
});

test('copy a folder within the home; the selected folder and the current folder cannot be chosen; the last target is offered first', async ({ page }, info) => {
  const headers = await signedIn(page);
  const dir = `/copypick-${info.project.name}`;
  await freshDir(page, headers, dir, ['A/inside.txt'], ['A', 'B']);

  await page.goto(`/home${dir}`);
  await row(page, 'A').getByRole('checkbox', { name: /^(A auswählen|Select A)$/ }).check();
  const bar = page.getByRole('group', { name: /Aktionen für die Auswahl|Actions for the selection/ });
  await bar.getByRole('button', { name: label('copy') }).click();
  const dialog = picker(page, 'copy');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^(Mein Speicher|My storage)$/ }).click();
  await dialog.getByRole('button', { name: dir.slice(1), exact: true }).click();
  // The folder the items are in, and the selected folder itself, are no target.
  const confirm = dialog.getByRole('button', { name: /^(Hierher kopieren|Copy here)$/ });
  await expect(confirm).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'A', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'B', exact: true }).click();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: /1 von 1 kopiert|1 of 1 copied/ })).toBeVisible();
  expect(await names(page, 'home', `${dir}/B/A`)).toEqual(['inside.txt']);
  expect(await names(page, 'home', dir)).toContain('A');

  // The next picker offers that folder first.
  await page.reload();
  await row(page, 'A').getByRole('button', { name: /(Aktionen für|Actions for) A$/ }).click();
  await menuItem(page, 'copy').click();
  const again = picker(page, 'copy');
  const first = again.locator('.move-to-list button').first();
  await expect(first).toContainText(/Zuletzt verwendet|Last used/);
  await expect(first).toContainText(`${dir.slice(1)} › B`);
  await first.click();
  await expect(again.getByRole('navigation')).toContainText('B');
});

test('Esc closes the picker and puts the focus back on the menu button; Shift+M opens it from the keyboard', async ({ page }, info) => {
  const headers = await signedIn(page);
  const dir = `/escpick-${info.project.name}`;
  await freshDir(page, headers, dir, ['note.txt']);

  await page.goto(`/home${dir}`);
  const menuButton = row(page, 'note.txt').getByRole('button', { name: /(Aktionen für|Actions for) note\.txt/ });
  await menuButton.click();
  await menuItem(page, 'copy').click();
  const dialog = picker(page, 'copy');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1); // the focus stays inside
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(menuButton).toBeFocused();

  await row(page, 'note.txt').focus();
  await page.keyboard.press('Shift+M');
  await expect(picker(page, 'move')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row(page, 'note.txt')).toBeFocused();
});
