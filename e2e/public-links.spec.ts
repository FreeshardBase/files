import { expect, test, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';

// #147: public links. `testuser` creates and manages links in the share dialog; the visitor is a fresh browser context
// with no session, the project's device and no stored language (so the browser's, English, applies).
// Both projects share one server; every test works in its own folder named after the project and test.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const crumbs = (page: Page) => page.getByRole('navigation', { name: /Pfad|Path/ });
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const shareDialog = (page: Page) => page.getByRole('dialog', { name: /teilen|Share/ });
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const menuButton = (page: Page, name: string) =>
  row(page, name).getByRole('button', { name: new RegExp(`(Aktionen für|Actions for) ${escape(name)}`) });

/** Creates `/<dir>` with files through the API as the page's user, then opens the home in the SPA. */
async function setup(page: Page, dir: string, files: Record<string, string>) {
  await page.goto('/');
  await expect(crumbs(page)).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  for (const [name, text] of Object.entries(files)) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(text) });
    expect(r.status()).toBe(201);
  }
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  return headers;
}

async function openShareDialog(page: Page, name: string) {
  await menuButton(page, name).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /^(Teilen|Share)$/ }).click();
  const d = shareDialog(page);
  await expect(d).toBeVisible();
  return d;
}

/** A visitor: a new context with the project's device, no cookies, English browser. */
async function visitor(browser: Browser, info: TestInfo, baseURL: string): Promise<Page> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const ctx = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, locale: 'en-US',
    acceptDownloads: true });
  return ctx.newPage();
}

test('a link with password and limit 1: the visitor unlocks, downloads once, and a second download is refused', async ({ page, browser, baseURL }, info) => {
  const dir = `link-limit-${tag(info)}`;
  await setup(page, dir, { 'report.txt': 'quarterly numbers' });
  const d = await openShareDialog(page, 'report.txt');
  await expect(d).toContainText(/Noch kein öffentlicher Link|No public link yet/);
  await d.getByRole('button', { name: /Neuer öffentlicher Link|New public link/ }).click();
  const form = d.getByRole('form', { name: /Neuer öffentlicher Link|New public link/ });
  await expect(form.getByLabel(/Bezeichnung|Label/)).toBeFocused();
  await form.getByLabel(/Bezeichnung|Label/).fill('For the accountant');
  await form.getByLabel(/Download-Limit|Download limit/).fill('1');
  await form.getByLabel(/^(Passwort|Password)$/).fill('open sesame');
  await form.getByRole('button', { name: /Link erstellen|Create link/ }).click();
  await expect(form).toHaveCount(0);
  const links = d.getByRole('list', { name: /Öffentliche Links|Public links/ });
  await expect(links).toContainText('For the accountant');
  await expect(links).toContainText(/Mit Passwort|With password/);
  await expect(links).toContainText(/0 von 1 Downloads|0 of 1 downloads/);
  const address = await links.getByRole('textbox', { name: /(Adresse von|Address of) For the accountant/ }).inputValue();
  expect(address).toMatch(new RegExp(`^${escape(baseURL!)}/s/[A-Za-z0-9_-]{22}$`));

  const v = await visitor(browser, info, baseURL!);
  const dialogs: string[] = [];
  v.on('dialog', (x) => { dialogs.push(x.message()); void x.dismiss(); });
  await v.goto(address);
  await expect(v.getByTestId('link-name')).toHaveText('report.txt');
  await expect(v.getByText('This link is protected by a password.')).toBeVisible();
  await expect(v.getByRole('link', { name: 'Download' })).toHaveCount(0);
  await v.getByLabel('Password').fill('wrong');
  await v.getByRole('button', { name: 'Open' }).click();
  await expect(v.getByRole('alert')).toHaveText('The password is not correct.');
  await expect(v.getByLabel('Password')).toBeFocused();
  await v.getByLabel('Password').fill('open sesame');
  await v.getByRole('button', { name: 'Open' }).click();
  await expect(v.getByRole('link', { name: 'Download' })).toBeVisible();
  await expect(v.getByText('Downloads left')).toBeVisible();

  const [download] = await Promise.all([v.waitForEvent('download'), v.getByRole('link', { name: 'Download' }).click()]);
  expect(download.suggestedFilename()).toBe('report.txt');
  expect(readFileSync(await download.path()).toString()).toBe('quarterly numbers');

  // The page still offers the button; the server counts and refuses, and the page says why in the visitor's language.
  await v.getByRole('link', { name: 'Download' }).click();
  await expect(v).toHaveURL(/\/s\/[A-Za-z0-9_-]{22}\?error=DOWNLOAD_LIMIT_REACHED$/);
  await expect(v.getByRole('alert').first()).toHaveText('This link has no downloads left.');
  await expect(v.getByTestId('link-name')).toHaveText('report.txt');
  expect(dialogs).toEqual([]);

  // The owner sees the count.
  await page.keyboard.press('Escape');
  const again = await openShareDialog(page, 'report.txt');
  await expect(again.getByRole('list', { name: /Öffentliche Links|Public links/ })).toContainText(/1 von 1 Downloads|1 of 1 downloads/);
  await v.context().close();
});

test('a link to a home folder: the visitor browses into a subfolder, previews and downloads a file, never above the folder (#208)', async ({ page, browser, baseURL }, info) => {
  const dir = `link-folder-${tag(info)}`;
  const headers = await setup(page, dir, { 'readme.txt': 'start here' });
  const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/Plans/floor.txt`)}&onCollision=fail`,
    { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from('ground floor') });
  expect(r.status()).toBe(201);
  await page.goto('/home');
  const d = await openShareDialog(page, dir);
  await d.getByRole('button', { name: /Neuer öffentlicher Link|New public link/ }).click();
  const form = d.getByRole('form', { name: /Neuer öffentlicher Link|New public link/ });
  await form.getByLabel(/Bezeichnung|Label/).fill('Architect');
  await form.getByRole('button', { name: /Link erstellen|Create link/ }).click();
  const address = await d.getByRole('list', { name: /Öffentliche Links|Public links/ })
    .getByRole('textbox', { name: /(Adresse von|Address of) Architect/ }).inputValue();

  const v = await visitor(browser, info, baseURL!);
  await v.goto(address);
  await expect(v.getByTestId('link-name')).toHaveText(dir);
  await expect(v.getByText('Shared folder')).toBeVisible();
  const contents = v.getByRole('list', { name: `Contents of ${dir}` });
  await expect(contents.getByRole('listitem')).toHaveCount(2);
  await contents.getByRole('link', { name: 'Open Plans' }).click();
  await expect(v).toHaveURL(/\?path=\/Plans$/);
  await expect(contents.getByRole('listitem')).toHaveCount(1);
  // Plain text opens inline in a new tab, like the preview of a file link.
  const [popup] = await Promise.all([v.waitForEvent('popup'), contents.getByRole('link', { name: 'Open preview of floor.txt' }).click()]);
  await expect(popup.locator('body')).toHaveText('ground floor');
  await popup.close();
  const [download] = await Promise.all([v.waitForEvent('download'), contents.getByRole('link', { name: 'Download floor.txt' }).click()]);
  expect(download.suggestedFilename()).toBe('floor.txt');
  expect(readFileSync(await download.path()).toString()).toBe('ground floor');
  await v.getByRole('link', { name: 'Up one folder' }).click();
  await expect(contents).toContainText('readme.txt');
  await expect(v.getByRole('link', { name: 'Up one folder' })).toHaveCount(0);
  // A path above the linked folder is refused, not resolved in the owner's home.
  expect((await v.request.get(`/s/${address.split('/s/')[1]}/list?path=${encodeURIComponent('/..')}`)).status()).toBe(400);
  await v.context().close();
});

test('a file named like markup is shown as text on the share page and the password prompt; no script runs', async ({ page, browser, baseURL }, info) => {
  const evil = '<img src=x onerror=alert(1)>.txt';
  const dir = `link-xss-${tag(info)}`;
  const headers = await setup(page, dir, { [evil]: 'harmless' });
  const r = await page.request.post('/api/v1/links', { headers,
    data: { source: 'home', path: `/${dir}/${evil}`, password: 'pw' } });
  expect(r.status()).toBe(201);
  const { token } = await r.json();

  const v = await visitor(browser, info, baseURL!);
  const dialogs: string[] = [];
  v.on('dialog', (x) => { dialogs.push(x.message()); void x.dismiss(); });
  const res = await v.goto(`/s/${token}`);
  expect(res!.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(res!.headers()['content-security-policy']).not.toMatch(/script-src[^;]*unsafe-inline/);
  // The password prompt shows the name as text.
  await expect(v.getByTestId('link-name')).toHaveText(evil);
  await expect(v.getByLabel('Password')).toBeVisible();
  await expect(v.locator('main img')).toHaveCount(0);
  await v.getByLabel('Password').fill('pw');
  await v.getByRole('button', { name: 'Open' }).click();
  // The unlocked share page shows it as text too.
  await expect(v.getByRole('link', { name: 'Download' })).toBeVisible();
  await expect(v.getByTestId('link-name')).toHaveText(evil);
  await expect(v.locator('main img')).toHaveCount(0);
  expect(dialogs).toEqual([]);
  await v.context().close();
});

test('the owner edits label, expiry, limit and password of a link, and revokes it', async ({ page, browser, baseURL }, info) => {
  const dir = `link-manage-${tag(info)}`;
  await setup(page, dir, {});
  await page.goto('/home');
  const d = await openShareDialog(page, dir);
  await d.getByRole('button', { name: /Neuer öffentlicher Link|New public link/ }).click();
  let form = d.getByRole('form', { name: /Neuer öffentlicher Link|New public link/ });
  await form.getByLabel(/Bezeichnung|Label/).fill('Plumber');
  await form.getByLabel(/Bezeichnung|Label/).press('Enter');
  const links = d.getByRole('list', { name: /Öffentliche Links|Public links/ });
  await expect(links).toContainText('Plumber');
  await expect(links).toContainText(/Ohne Passwort|No password/);
  await expect(links).toContainText(/kein Ablaufdatum|no expiry/);

  await d.getByRole('button', { name: /(Plumber bearbeiten|Edit Plumber)/ }).click();
  form = d.getByRole('form', { name: /(„Plumber“ bearbeiten|Edit “Plumber”)/ });
  await expect(form.getByLabel(/Bezeichnung|Label/)).toHaveValue('Plumber');
  await form.getByLabel(/Bezeichnung|Label/).fill('Electrician');
  await form.getByLabel(/Läuft ab|Expires/).fill('2099-12-24T18:30');
  await form.getByLabel(/Download-Limit|Download limit/).fill('5');
  await form.getByLabel(/^(Passwort|Password)$/).fill('new secret');
  await form.getByRole('button', { name: /Speichern|Save/ }).click();
  await expect(form).toHaveCount(0);
  await expect(links).toContainText('Electrician');
  await expect(links).toContainText(/Mit Passwort|With password/);
  await expect(links).toContainText(/0 von 5 Downloads|0 of 5 downloads/);
  await expect(links).toContainText(/2099/);
  const address = await links.getByRole('textbox', { name: /(Adresse von|Address of) Electrician/ }).inputValue();

  // Esc in the form closes only the form.
  await d.getByRole('button', { name: /(Electrician bearbeiten|Edit Electrician)/ }).click();
  await page.keyboard.press('Escape');
  await expect(d.getByRole('form')).toHaveCount(0);
  await expect(d).toBeVisible();

  const v = await visitor(browser, info, baseURL!);
  await v.goto(address);
  await expect(v.getByLabel('Password')).toBeVisible();

  await d.getByRole('button', { name: /(Electrician widerrufen|Revoke Electrician)/ }).click();
  await expect(links).toHaveCount(0);
  await expect(d).toContainText(/Noch kein öffentlicher Link|No public link yet/);
  await expect(d.getByRole('button', { name: /Neuer öffentlicher Link|New public link/ })).toBeFocused();
  await v.reload();
  await expect(v.getByRole('heading', { name: 'This link can’t be opened' })).toBeVisible();
  await expect(v.getByRole('alert')).toHaveText('This doesn\'t exist (any more).');
  await v.context().close();
});
