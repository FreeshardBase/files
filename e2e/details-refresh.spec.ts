import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';

// #231: the details drawer and the row show the item as it is now: after a version restore, and after an overwrite that
// finishes while the drawer is open.

const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const file = (name: string, text: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
const upload = (page: Page, f: ReturnType<typeof file>) => page.getByTestId('upload-input').setInputFiles([f]);
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const collision = (page: Page) => page.getByRole('dialog', { name: /schon vergeben|bereits vergeben|already taken/ });
// The drawer's facts: "Size" and its value.
const sizeIn = (drawer: Locator) => drawer.locator('.details-facts dt', { hasText: /^(Größe|Size)$/ }).locator('xpath=following-sibling::dd[1]');

async function openFolder(page: Page, dir: string, files: Record<string, string>) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  for (const [name, text] of Object.entries(files)) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=replace`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(text) });
    expect(r.status()).toBeLessThan(300);
  }
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toContainText(dir);
}

async function openDetails(page: Page, name: string): Promise<Locator> {
  await row(page, name).getByRole('button', { name: /Aktionen für|Actions for/ }).click();
  await page.getByRole('menuitem', { name: /^Details$/ }).click();
  const drawer = page.getByRole('dialog', { name: `Details ${name}`, exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
}

test('after a version restore, the open drawer and the row show the restored size at once', async ({ page }, info) => {
  const dir = `details-restore-${tag(info)}`;
  const name = 'Plan.txt';
  // Two writes: the first content (11 bytes) becomes a version of the second (25 bytes).
  await openFolder(page, dir, { [name]: 'first draft' });
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=replace`,
    { headers: { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin, 'content-type': 'application/octet-stream' },
      data: Buffer.from('second, much longer draft') });
  expect(r.status()).toBeLessThan(300);
  await page.reload();
  await expect(row(page, name)).toContainText(/25 byte/i);

  const drawer = await openDetails(page, name);
  await expect(sizeIn(drawer)).toHaveText(/25 byte/i);
  const versions = drawer.getByRole('list', { name: /^(Versionen|Versions)$/ });
  await versions.getByRole('button', { name: /(Version vom .* wiederherstellen|Restore the version from)/ }).click();
  await expect(drawer.getByRole('status')).toContainText(/wiederhergestellt|was restored/);
  // Still open: the facts are the restored file's, and so is the row behind the drawer.
  await expect(sizeIn(drawer)).toHaveText(/11 byte/i);
  await expect(row(page, name)).toContainText(/11 byte/i);
  await drawer.getByRole('button', { name: /^(Schließen|Close)$/ }).click();
  await expect(drawer).toHaveCount(0);
  await expect(row(page, name)).toContainText(/11 byte/i);
});

test('an overwrite that finishes while the drawer is open updates the drawer', async ({ page }, info) => {
  const dir = `details-overwrite-${tag(info)}`;
  const name = 'Notes.txt';
  await openFolder(page, dir, { [name]: 'short' });
  await expect(row(page, name)).toContainText(/5 byte/i);

  // The replacing upload's bytes are held back until the drawer is open.
  const held: Route[] = [];
  await page.route('**/api/v1/uploads/*', (route) => (route.request().method() === 'PATCH' ? void held.push(route) : route.continue()));
  await upload(page, file(name, 'a considerably longer note'));
  await collision(page).getByRole('button', { name: /^(Ersetzen|Replace)$/ }).click();
  await expect(collision(page)).toHaveCount(0);
  await expect.poll(() => held.length).toBe(1);

  const drawer = await openDetails(page, name);
  await expect(sizeIn(drawer)).toHaveText(/5 byte/i);
  await held[0]!.continue();
  await page.unroute('**/api/v1/uploads/*');
  await expect(sizeIn(drawer)).toHaveText(/26 byte/i);
  await expect(row(page, name)).toContainText(/26 byte/i);
});
