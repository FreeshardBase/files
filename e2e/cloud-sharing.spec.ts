import { expect, test, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { solidPng } from '../server/test/support/fakeDrive.ts';
import { openPlaces } from './places.ts';

// #208: shares and public links of items in the owner's Google Drive and Dropbox, against the cloud server
// (e2e/cloudServer.ts) and its fake providers. `testuser` owns the connection and shares; `member` receives; a visitor
// has no session. Neither the member's nor the visitor's browser ever talks to the provider: the shard proxies.
// Both projects share one server; every test works in its own folder named after the project and test.
test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const menuButton = (page: Page, name: string) =>
  row(page, name).getByRole('button', { name: new RegExp(`(Aktionen für|Actions for) ${escape(name)}`) });
const shareDialog = (page: Page) => page.getByRole('dialog', { name: /freigeben|Share/ });
/** Requests a browser sends to one of the fake providers' APIs or content hosts. */
const PROVIDER = /\/(drive|upload\/drive)\/v3\/|drive-(thumb|blob)|\/dropbox\//;

/** A new context with the project's device: signed in as `login`, or a visitor without a session when `login` is null. */
async function contextFor(browser: Browser, info: TestInfo, baseURL: string, login: string | null, returnTo = '/'): Promise<Page> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const ctx = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, locale: 'en-US',
    acceptDownloads: true });
  const p = await ctx.newPage();
  if (login) {
    await p.goto(`/auth/login?login_hint=${login}&returnTo=${encodeURIComponent(returnTo)}`);
    await expect(nav(p)).toBeVisible();
  }
  return p;
}
/** Every URL `page` (and its popups) requested at a fake provider. */
function providerRequests(page: Page): string[] {
  const seen: string[] = [];
  page.context().on('request', (r) => { if (PROVIDER.test(r.url())) seen.push(r.url()); });
  return seen;
}

/**
 * Signs `page` in as testuser with only a fresh connection to `provider` (earlier tests' connections are unlinked, as
 * in the other cloud specs), creates `files` in it through the API and answers the connection's source.
 */
async function connected(page: Page, provider: RegExp, files: Record<string, string | Buffer>) {
  await page.goto('/auth/login?returnTo=%2Fconnections');
  await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
    expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
  }
  await page.reload();
  await page.getByRole('button', { name: provider }).click();
  await expect(page.getByRole('heading', { name: 'Fake Cloud' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  const source = decodeURIComponent(new URL(page.url()).pathname.slice(1));
  for (const [path, body] of Object.entries(files)) {
    const r = await page.request.put(`/api/v1/sources/${encodeURIComponent(source)}/content?path=${encodeURIComponent(path)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(body) });
    expect(r.status(), await r.text()).toBe(201);
  }
  return { source, headers };
}

async function openShareDialog(page: Page, name: string) {
  await menuButton(page, name).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /^(Freigeben|Share)$/ }).click();
  const d = shareDialog(page);
  await expect(d).toBeVisible();
  return d;
}
async function shareWithMember(page: Page, name: string, access: 'read' | 'edit') {
  const d = await openShareDialog(page, name);
  await d.getByRole('combobox', { name: /Mitglied|Member/ }).fill('Test Mem');
  await d.getByRole('option', { name: 'Test Member' }).click();
  if (access === 'edit') await d.getByRole('radio', { name: /bearbeiten|edit/ }).check();
  await d.getByRole('button', { name: /^(Freigeben|Share)$/ }).click();
  await expect(d.getByRole('list', { name: /Wer hat Zugriff|Who has access/ }))
    .toContainText(access === 'edit' ? /Darf bearbeiten|Can edit/ : /Darf ansehen|Can view/);
  await page.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
}
async function sharedWithMe(member: Page, name: string): Promise<Locator> {
  await member.goto('/');
  await openPlaces(member);
  await nav(member).getByRole('link', { name: /Für mich freigegeben|Shared with me/ }).click();
  await expect(member).toHaveURL(/\/shared$/);
  const r = member.locator('tbody tr', { has: member.getByText(name, { exact: true }) });
  await expect(r).toContainText('Test User');
  return r;
}

test('the owner shares a Google Drive folder with edit; the member uploads into it and the file lands in the owner\'s drive', async ({ page, browser, baseURL }, info) => {
  const member = await contextFor(browser, info, baseURL!, 'member'); // known to the shard once signed in
  const fromMember = providerRequests(member);
  const dir = `Team-${tag(info)}`;
  const { source } = await connected(page, /Google Drive verbinden|Connect Google Drive/, { [`/${dir}/plan.txt`]: 'the plan' });
  await page.goto(`/${source}`);
  await expect(row(page, dir)).toBeVisible();
  await shareWithMember(page, dir, 'edit');

  const shared = await sharedWithMe(member, dir);
  await expect(shared).toContainText(/Darf bearbeiten|Can edit/);
  await shared.getByRole('link', { name: new RegExp(`(${escape(dir)} öffnen|Open ${escape(dir)})`) }).click();
  await expect(member).toHaveURL(/\/share:[0-9a-f]{32}$/);
  await expect(row(member, 'plan.txt')).toBeVisible();
  const name = `from-member-${info.project.name}.txt`;
  await member.getByTestId('upload-input').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('written by the member') });
  await expect(row(member, name)).toBeVisible();
  await expect(member.getByRole('status').filter({ hasText: /1 von 1 hochgeladen|1 of 1 uploaded/ })).toBeVisible();

  // The owner sees it in their drive, with the member's bytes.
  await page.goto(`/${source}/${encodeURIComponent(dir)}`);
  await expect(row(page, name)).toBeVisible();
  const down = await page.request.get(`/api/v1/sources/${encodeURIComponent(source)}/content?path=${encodeURIComponent(`/${dir}/${name}`)}`);
  expect(await down.text()).toBe('written by the member');
  expect(fromMember).toEqual([]);
  await member.context().close();
});

test('the owner shares a Dropbox file read-only; the member previews and downloads it, and no change is offered', async ({ page, browser, baseURL }, info) => {
  const member = await contextFor(browser, info, baseURL!, 'member');
  const fromMember = providerRequests(member);
  const dir = `Notes-${tag(info)}`;
  const file = `minutes-${tag(info)}.txt`;
  const { source } = await connected(page, /Dropbox verbinden|Connect Dropbox/, { [`/${dir}/${file}`]: 'minutes of the meeting' });
  await page.goto(`/${source}/${encodeURIComponent(dir)}`);
  await expect(row(page, file)).toBeVisible();
  await shareWithMember(page, file, 'read');

  const shared = await sharedWithMe(member, file);
  await expect(shared).toContainText(/Darf ansehen|Can view/);
  // A read-only file offers exactly preview and download.
  await expect(shared.locator('td.actions').getByRole('button')).toHaveText([/^(Vorschau|Preview)$/]);
  await expect(shared.locator('td.actions').getByRole('link')).toHaveText([/^(Herunterladen|Download)$/]);
  await expect(member.getByTestId('upload-input')).toHaveCount(0);

  await shared.getByRole('button', { name: new RegExp(`(Vorschau von ${escape(file)}|Preview ${escape(file)})`) }).click();
  const preview = member.getByRole('dialog', { name: file, exact: true });
  await expect(preview.locator('pre')).toHaveText('minutes of the meeting');
  await expect(preview.getByRole('button', { name: /Umbenennen|Rename|Papierkorb|Trash|Löschen|Delete|Hochladen|Upload/ })).toHaveCount(0);
  const [inPreview] = await Promise.all([member.waitForEvent('download'),
    preview.getByRole('link', { name: /^(Herunterladen|Download)$/ }).click()]);
  expect(readFileSync(await inPreview.path()).toString()).toBe('minutes of the meeting');
  await member.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);

  const [download] = await Promise.all([member.waitForEvent('download'),
    shared.getByRole('link', { name: new RegExp(`(${escape(file)} herunterladen|Download ${escape(file)})`) }).click()]);
  expect(download.suggestedFilename()).toBe(file);
  expect(readFileSync(await download.path()).toString()).toBe('minutes of the meeting');
  expect(fromMember).toEqual([]);
  await member.context().close();
});

test('a public link to a Dropbox folder: the visitor browses into a subfolder, previews an image and downloads a file', async ({ page, browser, baseURL }, info) => {
  const dir = `Album-${tag(info)}`;
  const png = await solidPng(40, 30, '#3a6');
  const { source, headers } = await connected(page, /Dropbox verbinden|Connect Dropbox/, {
    [`/${dir}/cover.txt`]: 'the album', [`/${dir}/2026/beach.png`]: png, [`/${dir}/2026/notes.txt`]: 'sunny days' });
  const r = await page.request.post('/api/v1/links', { headers, data: { source, path: `/${dir}` } });
  expect(r.status(), await r.text()).toBe(201);
  const { token } = await r.json();

  const v = await contextFor(browser, info, baseURL!, null);
  const fromVisitor = providerRequests(v);
  await v.goto(`/s/${token}`);
  await expect(v.getByTestId('link-name')).toHaveText(dir);
  const contents = v.getByRole('list', { name: `Contents of ${dir}` });
  await expect(contents.getByRole('listitem')).toHaveCount(2);
  await contents.getByRole('link', { name: 'Open 2026' }).click();
  await expect(v).toHaveURL(/\?path=\/2026$/);
  await expect(contents.getByRole('listitem')).toHaveCount(2);
  await expect(contents).toContainText('beach.png');

  const [popup] = await Promise.all([v.waitForEvent('popup'), contents.getByRole('link', { name: 'Open preview of beach.png' }).click()]);
  await expect.poll(() => popup.evaluate(() => document.images[0]?.naturalWidth ?? 0)).toBe(40);
  await popup.close();
  const [download] = await Promise.all([v.waitForEvent('download'), contents.getByRole('link', { name: 'Download notes.txt' }).click()]);
  expect(download.suggestedFilename()).toBe('notes.txt');
  expect(readFileSync(await download.path()).toString()).toBe('sunny days');
  // "Up one folder" goes back to the linked folder and no further.
  await v.getByRole('link', { name: 'Up one folder' }).click();
  await expect(contents).toContainText('cover.txt');
  await expect(v.getByRole('link', { name: 'Up one folder' })).toHaveCount(0);
  expect(fromVisitor).toEqual([]);
  await v.context().close();
});

test('a public link to a Google Drive file with a password and limit 1: unlocked, downloaded once, then refused', async ({ page, browser, baseURL }, info) => {
  const file = `contract-${tag(info)}.txt`;
  const { source } = await connected(page, /Google Drive verbinden|Connect Google Drive/, { [`/${file}`]: 'signed contract' });
  await page.goto(`/${source}`);
  const d = await openShareDialog(page, file);
  await d.getByRole('button', { name: /Neuer öffentlicher Link|New public link/ }).click();
  const form = d.getByRole('form', { name: /Neuer öffentlicher Link|New public link/ });
  await form.getByLabel(/Bezeichnung|Label/).fill('For the notary');
  await form.getByLabel(/Download-Limit|Download limit/).fill('1');
  await form.getByLabel(/^(Passwort|Password)$/).fill('open sesame');
  await form.getByRole('button', { name: /Link erstellen|Create link/ }).click();
  const links = d.getByRole('list', { name: /Öffentliche Links|Public links/ });
  await expect(links).toContainText(/0 von 1 Downloads|0 of 1 downloads/);
  const address = await links.getByRole('textbox', { name: /(Adresse von|Address of) For the notary/ }).inputValue();

  const v = await contextFor(browser, info, baseURL!, null);
  const fromVisitor = providerRequests(v);
  await v.goto(address);
  await expect(v.getByTestId('link-name')).toHaveText(file);
  await expect(v.getByRole('link', { name: 'Download' })).toHaveCount(0);
  await v.getByLabel('Password').fill('wrong');
  await v.getByRole('button', { name: 'Open' }).click();
  await expect(v.getByRole('alert')).toHaveText('The password is not correct.');
  await v.getByLabel('Password').fill('open sesame');
  await v.getByRole('button', { name: 'Open' }).click();
  const [download] = await Promise.all([v.waitForEvent('download'), v.getByRole('link', { name: 'Download' }).click()]);
  expect(readFileSync(await download.path()).toString()).toBe('signed contract');
  // The page counts down and offers no more (#232); a download sent anyway is refused by the server.
  await expect(v.getByRole('link', { name: 'Download' })).toHaveCount(0);
  await v.goto(`${address}/content?path=%2F`);
  await expect(v).toHaveURL(/\/s\/[A-Za-z0-9_-]{22}\?error=DOWNLOAD_LIMIT_REACHED$/);
  await expect(v.getByRole('alert').first()).toHaveText('This link has no downloads left.');
  expect(fromVisitor).toEqual([]);
  await v.context().close();
});
