import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openPlaces } from './places.ts';

// #299: "My shares" lists the owner's public links and the shares they granted across every source, here the home and
// the fake Google Drive of the cloud server (e2e/cloudServer.ts). Copy, edit (the item's share dialog), revoke and
// remove work from the page; what the page shows is what the share dialog shows. Runs on desktop and phone width.
// Earlier tests leave their own links behind, so rows are found by this test's item names, never counted.
test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const linkList = (page: Page) => page.locator('main').getByRole('list', { name: /Öffentliche Links|Public links/ });
const shareList = (page: Page) => page.locator('main').getByRole('list', { name: /Für Mitglieder freigegeben|Shared with members/ });
/** The row of `list` whose item link opens `name`. */
const rowOf = (list: Locator, name: string) => list.getByRole('listitem')
  .filter({ has: list.page().getByRole('link', { name: new RegExp(`^(${escape(name)} öffnen|Open ${escape(name)})$`) }) });

const selectors = readFileSync(new URL('./fixtures/generic-cosmetic-rules.txt', import.meta.url), 'utf8').split('\n')
  .map((l) => l.trim()).filter((l) => l.startsWith('##')).map((l) => l.slice(2));
const blockerCss = `${selectors.join(',\n')} { display: none !important; }`;

/** testuser with only a fresh Google Drive connection (as in the other cloud specs); answers its source and the headers. */
async function connectDrive(page: Page) {
  await page.goto('/auth/login?returnTo=%2Fconnections');
  await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
    expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
  }
  await page.reload();
  await page.getByRole('button', { name: /Google Drive verbinden|Connect Google Drive/ }).click();
  await expect(page.getByRole('heading', { name: 'Fake Cloud' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  return { drive: decodeURIComponent(new URL(page.url()).pathname.slice(1)), headers };
}

test('links on home and Drive and a share appear on "My shares"; edit, revoke and remove work from there', async ({ page, browser, baseURL }, info) => {
  // The member is known to the shard once they have signed in.
  const ctx = await browser.newContext({ baseURL });
  const m = await ctx.newPage();
  await m.goto('/auth/login?login_hint=member&returnTo=%2F');
  await expect(nav(m)).toBeAttached();
  await ctx.close();

  const { drive, headers } = await connectDrive(page);
  const dir = `mine-${tag(info)}`;
  const homeName = `home-${tag(info)}.txt`; const driveName = `drive-${tag(info)}.txt`;
  const put = async (source: string, path: string) => {
    const r = await page.request.put(`/api/v1/sources/${encodeURIComponent(source)}/content?path=${encodeURIComponent(path)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from('report') });
    expect(r.status(), await r.text()).toBe(201);
  };
  await put('home', `/${dir}/${homeName}`);
  await put(drive, `/${dir}/${driveName}`);
  const link = async (source: string, path: string, label: string, extra: object = {}) => {
    const r = await page.request.post('/api/v1/links', { headers, data: { source, path, label, ...extra } });
    expect(r.status(), await r.text()).toBe(201);
  };
  await link('home', `/${dir}/${homeName}`, `Home link ${tag(info)}`, { password: 'secret1', maxDownloads: 5 });
  await link(drive, `/${dir}/${driveName}`, `Drive link ${tag(info)}`);
  const grantee = ((await (await page.request.get('/api/v1/members')).json()).items as { id: string; displayName: string }[])
    .find((x) => x.displayName === 'Test Member')!.id;
  const share = await page.request.post('/api/v1/shares', { headers, data: { source: drive, path: `/${dir}/${driveName}`, grantee, access: 'edit' } });
  expect(share.status(), await share.text()).toBe(201);

  // From the sidebar, under the generic ad-block rules (#295).
  await page.goto('/home');
  await page.addStyleTag({ content: blockerCss });
  await (await openPlaces(page)).getByRole('link', { name: /^(Meine Freigaben|My shares)$/ }).click();
  await expect(page).toHaveURL(/\/my-shares$/);
  await page.addStyleTag({ content: blockerCss });
  await expect(page.getByRole('heading', { level: 1, name: /Meine Freigaben|My shares/ })).toBeVisible();

  const homeRow = rowOf(linkList(page), homeName);
  const driveRow = rowOf(linkList(page), driveName);
  await expect(homeRow).toBeVisible();
  await expect(homeRow).toContainText(`Home link ${tag(info)}`);
  await expect(homeRow).toContainText(new RegExp(`(Mein Speicher|My storage) › ${escape(dir)}`));
  await expect(homeRow).toContainText(/Mit Passwort|With password/);
  await expect(homeRow).toContainText(/0 (von|of) 5/);
  await expect(homeRow.getByRole('textbox')).toHaveValue(/\/s\/[A-Za-z0-9_-]{22}$/);
  await expect(driveRow).toBeVisible();
  await expect(driveRow).toContainText(`Drive link ${tag(info)}`);
  await expect(driveRow).toContainText(new RegExp(`Google Drive › ${escape(dir)}`));
  const shareRow = rowOf(shareList(page), driveName);
  await expect(shareRow).toBeVisible();
  await expect(shareRow).toContainText('Test Member');
  await expect(shareRow).toContainText(/Darf bearbeiten|Can edit/);

  // Edit opens the item's share dialog, which lists the same link and access.
  await driveRow.getByRole('button', { name: new RegExp(`^(Drive link ${escape(tag(info))} bearbeiten|Edit Drive link ${escape(tag(info))})$`) }).click();
  const d = page.getByRole('dialog', { name: new RegExp(`${escape(driveName)}`) });
  await expect(d).toBeVisible();
  await expect(d.getByRole('list', { name: /Öffentliche Links|Public links/ })).toContainText(`Drive link ${tag(info)}`);
  await expect(d.getByRole('list', { name: /Wer hat Zugriff|Who has access/ })).toContainText('Test Member');
  // The member field has the focus and its open list takes the first Esc; the next one closes the dialog.
  await expect(async () => {
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0, { timeout: 500 });
  }).toPass();

  // Revoke asks first, then the row is gone, and the item's share dialog no longer lists the link.
  await homeRow.getByRole('button', { name: /^(Widerrufen|Revoke|.* widerrufen|Revoke .*)$/ }).click();
  const confirm = page.getByRole('dialog', { name: /widerrufen\?|Revoke .*\?/ });
  await confirm.getByRole('button', { name: /^(Widerrufen|Revoke)$/ }).click();
  await expect(homeRow).toHaveCount(0);
  await expect(driveRow).toBeVisible();
  const mine = (await (await page.request.get('/api/v1/links/mine')).json()).items as { label: string }[];
  expect(mine.map((l) => l.label)).not.toContain(`Home link ${tag(info)}`);

  // Removing the share takes the member's access away.
  await shareRow.getByRole('button', { name: /(Zugriff von|Remove access of) Test Member/ }).click();
  await expect(shareRow).toHaveCount(0);
  const access = await page.request.get(`/api/v1/shares?${new URLSearchParams({ source: drive, path: `/${dir}/${driveName}` })}`);
  expect((await access.json()).items).toEqual([]);

  // The item opens its folder with the file selected.
  await rowOf(linkList(page), driveName).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/conn:[0-9a-f]{32}/${escape(dir)}\\?select=`));

  // The share dialog in the folder view shows what the page showed: the Drive link, not the revoked home link.
  await page.goto(`/home/${dir}`);
  const row = page.locator('tbody tr', { has: page.locator('.name').getByText(homeName, { exact: true }) });
  await row.getByRole('button', { name: new RegExp(`(Aktionen für|Actions for) ${escape(homeName)}`) }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /^(Freigeben|Share)$/ }).click();
  const homeDialog = page.getByRole('dialog', { name: /freigeben|Share/ });
  await expect(homeDialog).toBeVisible();
  await expect(homeDialog.getByText(/Noch kein öffentlicher Link|No public link yet/)).toBeVisible();
});

test('"My shares" of a member who has shared nothing says so', async ({ browser, baseURL }, info) => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const ctx = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
  const p = await ctx.newPage();
  await p.goto('/auth/login?login_hint=member2&returnTo=%2Fmy-shares');
  await expect(p.getByRole('heading', { level: 1, name: /Meine Freigaben|My shares/ })).toBeVisible();
  await expect(p.getByText(/(Du hast|Sie haben) noch nichts freigegeben|You have not shared anything yet/)).toBeVisible();
  await expect(linkList(p)).toHaveCount(0);
  await ctx.close();
});
