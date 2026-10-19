import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

// #382: the details drawer's "Who has access" lists the item's active public links and says "Only you." only when there
// is neither a member share nor an active link.

const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const onlyYou = /Nur du\.|Nur Sie\.|Only you\./;

async function openDetails(page: Page, name: string): Promise<Locator> {
  await row(page, name).getByRole('button', { name: /Aktionen für|Actions for/ }).click();
  await page.getByRole('menuitem', { name: /^Details$/ }).click();
  const drawer = page.getByRole('dialog', { name: `Details ${name}`, exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function closeDetails(drawer: Locator) {
  await drawer.getByRole('button', { name: /^(Schließen|Close)$/ }).click();
  await expect(drawer).toHaveCount(0);
}

test('#382: the details drawer lists an active public link under "Who has access" and is "Only you." once it is revoked', async ({ page }, info) => {
  const dir = `details-access-${tag(info)}`;
  const name = 'notes.md';
  const path = `/${dir}/${name}`;
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  const put = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=replace`,
    { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from('# notes') });
  expect(put.status()).toBeLessThan(300);

  // Without any share or active link the drawer says so; a link whose downloads are used up opens nothing.
  const used = await page.request.post('/api/v1/links', { headers,
    data: { source: 'home', path, label: 'Used up', expiresAt: null, maxDownloads: 0, password: null } });
  expect(used.status()).toBeLessThan(300);
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  let drawer = await openDetails(page, name);
  await expect(drawer).toContainText(onlyYou);
  await expect(drawer).not.toContainText('Used up');
  await closeDetails(drawer);

  const created = await page.request.post('/api/v1/links', { headers,
    data: { source: 'home', path, label: 'For the printer', expiresAt: null, maxDownloads: null, password: null } });
  expect(created.status()).toBeLessThan(300);
  const { id } = await created.json();

  drawer = await openDetails(page, name);
  const who = drawer.getByRole('list', { name: /^(Wer hat Zugriff|Who has access)$/ });
  await expect(who).toContainText('For the printer');
  await expect(who).toContainText(/Alle mit dem Link|Anyone with the link/);
  await expect(drawer).not.toContainText(onlyYou);
  await closeDetails(drawer);

  expect((await page.request.delete(`/api/v1/links/${encodeURIComponent(id)}`, { headers })).status()).toBeLessThan(300);
  drawer = await openDetails(page, name);
  await expect(drawer).toContainText(onlyYou);
  await expect(drawer).not.toContainText('For the printer');
});
