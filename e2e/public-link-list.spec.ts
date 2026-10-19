import { expect, test, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';

// #291: a public link created in the share dialog shows in the dialog's list right after "Create link" and after the
// dialog is opened again, for a file and a folder, in the home and in a Google Drive (the cloud server's fake), the
// item opened from its folder listing, from the search and (home only) from Recent. The visitor opens the link.
test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shareDialog = (page: Page) => page.getByRole('dialog', { name: /freigeben|Share/ });
const box = (page: Page) => page.getByRole('combobox', { name: /Dateien nach Namen suchen|Search files by name/ });
const linkList = (d: Locator) => d.getByRole('list', { name: /Öffentliche Links|Public links/ });

type Where = { source: string; headers: Record<string, string> };

/** testuser's headers for API calls, after the SPA has loaded. */
async function headersOf(page: Page): Promise<Record<string, string>> {
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  return { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
}

/** The home, signed in as testuser. */
async function home(page: Page): Promise<Where> {
  await page.goto('/auth/login?returnTo=%2Fhome');
  await expect(nav(page)).toBeAttached();
  return { source: 'home', headers: await headersOf(page) };
}

/** testuser with only a fresh Google Drive connection (earlier tests' connections are unlinked). */
async function drive(page: Page): Promise<Where> {
  await page.goto('/auth/login?returnTo=%2Fconnections');
  await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
  const headers = await headersOf(page);
  for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
    expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
  }
  await page.reload();
  await page.getByRole('button', { name: /Google Drive verbinden|Connect Google Drive/ }).click();
  await expect(page.getByRole('heading', { name: 'Fake Cloud' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  return { source: decodeURIComponent(new URL(page.url()).pathname.slice(1)), headers };
}

async function put(page: Page, w: Where, path: string, body: string) {
  const r = await page.request.put(`/api/v1/sources/${encodeURIComponent(w.source)}/content?path=${encodeURIComponent(path)}&onCollision=fail`,
    { headers: { ...w.headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(body) });
  expect(r.status(), await r.text()).toBe(201);
}
const folderUrl = (w: Where, dir: string) => `/${w.source}/${encodeURIComponent(dir)}`;

async function openShareDialog(page: Page, name: string): Promise<Locator> {
  await row(page, name).getByRole('button', { name: new RegExp(`(Aktionen für|Actions for) ${escape(name)}`) }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /^(Freigeben|Share)$/ }).click();
  const d = shareDialog(page);
  await expect(d).toBeVisible();
  return d;
}

/** Creates an unnamed link in the open dialog and answers its address; the list shows it at once. */
async function createLink(page: Page, d: Locator): Promise<string> {
  await expect(d).toContainText(/Noch kein öffentlicher Link|No public link yet/);
  await d.getByRole('button', { name: /Neuer öffentlicher Link|New public link/ }).click();
  const form = d.getByRole('form', { name: /Neuer öffentlicher Link|New public link/ });
  await form.getByRole('button', { name: /Link erstellen|Create link/ }).click();
  await expect(form).toHaveCount(0);
  await expect(d.getByRole('alert')).toHaveCount(0);
  await expect(linkList(d).getByRole('listitem')).toHaveCount(1);
  await expect(d).not.toContainText(/Noch kein öffentlicher Link|No public link yet/);
  return linkList(d).getByRole('textbox').inputValue();
}

// "Close", not Esc: with other members on the shard the focused member picker is open, and Esc closes only its list.
async function closeDialog(d: Locator) {
  await d.getByRole('button', { name: /^(Schließen|Close)$/ }).click();
  await expect(d).toHaveCount(0);
}

/** Closes the dialog, opens it again for `name` and expects the one link with `address`. */
async function reopenShows(page: Page, d: Locator, name: string, address: string) {
  await closeDialog(d);
  const again = await openShareDialog(page, name);
  await expect(linkList(again).getByRole('listitem')).toHaveCount(1);
  await expect(linkList(again).getByRole('textbox')).toHaveValue(address);
  await closeDialog(again);
}

async function visitorSees(browser: Browser, info: TestInfo, baseURL: string, address: string, name: string) {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const ctx = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, locale: 'en-US' });
  const v = await ctx.newPage();
  await v.goto(address);
  await expect(v.getByTestId('link-name')).toHaveText(name);
  await expect(v.getByRole('alert')).toHaveCount(0);
  await ctx.close();
}

for (const [label, open] of [['home', home], ['Google Drive', drive]] as const) {
  test(`${label}: links to a file and a folder opened from the folder listing show after creating and reopening`, async ({ page, browser, baseURL }, info) => {
    const w = await open(page);
    const dir = `links-${label.replace(' ', '')}-${tag(info)}`;
    const file = 'ubuntu-desktop-bootstrap_ubuntu-desktop-bootstrap.desktop';
    await put(page, w, `/${dir}/${file}`, '[Desktop Entry]');
    await put(page, w, `/${dir}/Fotos/a.txt`, 'a');

    await page.goto(folderUrl(w, dir));
    await expect(row(page, file)).toBeVisible();
    let d = await openShareDialog(page, file);
    const fileLink = await createLink(page, d);
    await reopenShows(page, d, file, fileLink);

    d = await openShareDialog(page, 'Fotos');
    const folderLink = await createLink(page, d);
    await reopenShows(page, d, 'Fotos', folderLink);

    await visitorSees(browser, info, baseURL!, fileLink, file);
    await visitorSees(browser, info, baseURL!, folderLink, 'Fotos');
  });

  test(`${label}: a link to a file opened from the search shows after creating and reopening`, async ({ page, browser, baseURL }, info) => {
    const w = await open(page);
    const dir = `found-${label.replace(' ', '')}-${tag(info)}`;
    const file = `Found ${label} ${tag(info)}.txt`;
    await put(page, w, `/${dir}/${file}`, 'found');

    await page.goto(`/${w.source}`);
    await box(page).fill(`found ${label} ${tag(info)}`);
    const option = page.getByRole('listbox', { name: /Suchergebnisse|Search results/ }).getByRole('option', { name: new RegExp(escape(file)) });
    await option.click();
    await expect(row(page, file)).toBeVisible();
    const d = await openShareDialog(page, file);
    const link = await createLink(page, d);
    await reopenShows(page, d, file, link);
    await visitorSees(browser, info, baseURL!, link, file);
  });
}

// Recent records only the home's writes (CONCEPTS.md, "Recent"), so a cloud item never appears there.
test('home: a link to a file opened from Recent shows after creating and reopening', async ({ page, browser, baseURL }, info) => {
  const w = await home(page);
  const dir = `recent-links-${tag(info)}`;
  const file = `Recent link ${tag(info)}.txt`;
  await put(page, w, `/${dir}/${file}`, 'recent');
  await page.goto('/recent');
  await row(page, file).getByRole('link', { name: new RegExp(`(Ordner von|folder of) ${escape(file)}`) }).click();
  await expect(row(page, file)).toBeVisible();
  const d = await openShareDialog(page, file);
  const link = await createLink(page, d);
  await reopenShows(page, d, file, link);
  await visitorSees(browser, info, baseURL!, link, file);
});

// #371: "New public link" keeps the usual block spacing (--space-4) above the action row's hairline.
test('the “New public link” button keeps 16 px above the dialog’s action row (#371)', async ({ page }, info) => {
  const w = await home(page);
  const dir = `link-gap-${tag(info)}`;
  await put(page, w, `/${dir}/gap.txt`, 'gap');
  await page.goto(folderUrl(w, dir));
  const d = await openShareDialog(page, 'gap.txt');
  const button = d.getByRole('button', { name: /Neuer öffentlicher Link|New public link/ });
  await expect(button).toBeVisible();
  const bottom = (await button.boundingBox())!;
  const actions = (await d.locator('.app-dialog-actions').boundingBox())!;
  expect(actions.y - (bottom.y + bottom.height)).toBeGreaterThanOrEqual(16);
  await closeDialog(d);
});
