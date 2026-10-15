import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';

// #154: a replaced file keeps its previous content as a version; the details drawer lists, downloads and restores it.

const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const file = (name: string, text: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
const upload = (page: Page, f: ReturnType<typeof file>) => page.getByTestId('upload-input').setInputFiles([f]);
const status = (page: Page) => page.getByRole('status');
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const collision = (page: Page) => page.getByRole('dialog', { name: /schon vergeben|bereits vergeben|already taken/ });
const contentOf = async (page: Page, path: string) =>
  (await page.request.get(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}`)).text();

async function openFolder(page: Page, dir: string) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toContainText(dir);
}

async function openDetails(page: Page, name: string): Promise<Locator> {
  await row(page, name).getByRole('button', { name: /Aktionen für|Actions for/ }).click();
  await page.getByRole('menuitem', { name: /^Details$/ }).click();
  const drawer = page.getByRole('dialog', { name: new RegExp(`Details (zu|of) .${name.replace(/[.]/g, '\\.')}.`) });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function downloadFrom(page: Page, link: Locator): Promise<{ name: string; text: string }> {
  const [d] = await Promise.all([page.waitForEvent('download'), link.click()]);
  return { name: d.suggestedFilename(), text: readFileSync(await d.path()).toString() };
}

test('replace a file, restore the old content from the versions in the drawer, and download both', async ({ page }, info) => {
  const dir = `versions-${tag(info)}`;
  const name = 'Plan.txt';
  await openFolder(page, dir);

  await upload(page, file(name, 'first draft'));
  await expect(status(page)).toContainText(/1 von 1|1 of 1/);
  await expect(row(page, name)).toBeVisible();
  await upload(page, file(name, 'second draft'));
  await collision(page).getByRole('button', { name: /^(Ersetzen|Replace)$/ }).click();
  await expect(collision(page)).toHaveCount(0);
  await expect.poll(() => contentOf(page, `/${dir}/${name}`)).toBe('second draft');

  const drawer = await openDetails(page, name);
  const versions = drawer.getByRole('list', { name: /^(Versionen|Versions)$/ });
  await expect(versions.getByRole('listitem')).toHaveCount(1);
  const old = await downloadFrom(page, versions.getByRole('link', { name: /(Version vom .* herunterladen|Download the version from)/ }));
  expect(old).toEqual({ name, text: 'first draft' });

  await versions.getByRole('button', { name: /(Version vom .* wiederherstellen|Restore the version from)/ }).click();
  await expect(drawer.getByRole('status')).toContainText(/wiederhergestellt|was restored/);
  await expect.poll(() => contentOf(page, `/${dir}/${name}`)).toBe('first draft');
  // The replaced content is now the one version; the folder shows the restored file's size.
  await expect(versions.getByRole('listitem')).toHaveCount(1);
  const replaced = await downloadFrom(page, versions.getByRole('link', { name: /(herunterladen|Download the version)/ }));
  expect(replaced.text).toBe('second draft');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(row(page, name)).toContainText(/11 byte/i);
});

test('a new file has no versions yet, and the drawer says so', async ({ page }, info) => {
  const dir = `versions-none-${tag(info)}`;
  await openFolder(page, dir);
  await upload(page, file('Neu.txt', 'x'));
  await expect(row(page, 'Neu.txt')).toBeVisible();
  const drawer = await openDetails(page, 'Neu.txt');
  await expect(drawer).toContainText(/Noch keine früheren Versionen|No earlier versions yet/);
  await expect(drawer.getByRole('button', { name: /wiederherstellen|Restore/ })).toHaveCount(0);
});
