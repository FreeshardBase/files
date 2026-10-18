import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';

// #217: file requests. `testuser` creates a request on a folder in the "File requests" page; the visitor is a fresh
// browser context with no session, the project's device and English. Both projects share one server; every test works
// in its own folder named after the project and test.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Creates `/<dir>` with files through the API as the page's user. */
async function setup(page: Page, dir: string, files: Record<string, string> = {}) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  for (const [name, text] of Object.entries(files)) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(text) });
    expect(r.status()).toBe(201);
  }
}

async function visitor(browser: Browser, info: TestInfo, baseURL: string): Promise<Page> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const ctx = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, locale: 'en-US' });
  return ctx.newPage();
}

/** Opens "File requests" from the sidebar (the menu button first on a phone). */
async function openRequests(page: Page) {
  const toggle = page.getByRole('button', { name: /^(Orte|Places)$/ });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('link', { name: /^(Dateianfragen|File requests)/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Dateianfragen|File requests/ })).toBeVisible();
}

/** Creates a request on `/<dir>` through the dialog and returns its address. */
async function createRequest(page: Page, dir: string, title: string, fill?: (d: ReturnType<Page['getByRole']>) => Promise<void>) {
  await openRequests(page);
  await page.getByRole('button', { name: /Neue Dateianfrage|New file request/ }).click();
  const d = page.getByRole('dialog', { name: /Neue Dateianfrage|New file request/ });
  await expect(d).toBeVisible();
  await d.getByRole('button', { name: dir, exact: true }).click();
  await expect(d).toContainText(new RegExp(`(Dateien landen in|Files go to): (Mein Speicher|My storage) › ${escape(dir)}`));
  await d.getByLabel(/^(Titel|Title)$/).fill(title);
  if (fill) await fill(d);
  await d.getByRole('button', { name: /Anfrage erstellen|Create request/ }).click();
  await expect(d).toHaveCount(0);
  const list = page.getByRole('list', { name: /Dateianfragen|File requests/ });
  return list.getByRole('textbox', { name: new RegExp(`(Adresse von|Address of) ${escape(title)}`) }).inputValue();
}

test('an anonymous visitor uploads two files; the owner sees the badge, the files and the sender\'s name', async ({ page, browser, baseURL }, info) => {
  const dir = `request-${tag(info)}`;
  await setup(page, dir, { 'private.txt': 'owner only' });
  const title = `Photos ${tag(info)}`;
  const address = await createRequest(page, dir, title, async (d) => {
    await d.getByLabel(/Nach dem Namen fragen|Ask senders for their name/).check();
  });
  expect(address).toMatch(new RegExp(`^${escape(baseURL!)}/r/[A-Za-z0-9_-]{22}$`));

  const v = await visitor(browser, info, baseURL!);
  await v.goto(address);
  await expect(v.getByTestId('request-title')).toHaveText(title);
  await expect(v.getByText('You have not sent any files yet.')).toBeVisible();
  // The folder is never shown: neither its name nor what is in it.
  await expect(v.locator('body')).not.toContainText('private.txt');
  await expect(v.locator('body')).not.toContainText(dir);
  await v.getByLabel('Your name (optional)').fill('Test User');
  await v.getByTestId('request-picker').setInputFiles([
    { name: 'beach.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('sand and sea') },
    { name: 'hike.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('mountains') },
  ]);
  const yours = v.getByRole('list', { name: 'Your files' });
  await expect(yours.getByRole('listitem')).toHaveCount(2);
  await expect(yours.getByRole('listitem').filter({ hasText: 'beach.jpg' })).toContainText('Sent');
  await expect(yours.getByRole('listitem').filter({ hasText: 'hike.jpg' })).toContainText('Sent');
  await expect(v.locator('body')).not.toContainText('private.txt');

  // The owner: the sidebar's badge and the request's own, then the files with the sender's name; looking clears both.
  await page.reload();
  const item = page.getByRole('list', { name: /Dateianfragen|File requests/ }).getByRole('listitem').filter({ hasText: title });
  await expect(item).toContainText(/2 neu|2 new/);
  await expect(item).toContainText(/2 Dateien|2 files/);
  // The sidebar counts the new files of all requests (other tests' requests share the server).
  const toggle = page.getByRole('button', { name: /^(Orte|Places)$/ });
  const navLink = page.getByRole('link', { name: /^(Dateianfragen|File requests)/ });
  const newInNav = async () => {
    if (await toggle.isVisible()) await toggle.click();
    const badge = navLink.locator('.nav-badge');
    const said = await badge.count() ? await badge.getAttribute('title') ?? '' : '';
    if (await toggle.isVisible()) await toggle.click();
    if (/^(eine neue Datei|one new file)$/.test(said)) return 1;
    return Number(/^(\d+) (neue Dateien|new files)$/.exec(said)?.[1] ?? 0);
  };
  const before = await newInNav();
  expect(before).toBeGreaterThanOrEqual(2);
  await item.getByRole('button', { name: new RegExp(`(Dateien anzeigen, die über ${escape(title)}|Show the files received through ${escape(title)})`) }).click();
  const files = page.getByRole('dialog', { name: new RegExp(escape(title)) });
  await expect(files.getByRole('listitem')).toHaveCount(2);
  await expect(files.getByRole('listitem').filter({ hasText: 'beach.jpg' })).toContainText(/von Test User|from Test User/);
  await expect(files.getByRole('listitem').filter({ hasText: 'hike.jpg' })).toContainText(/Neu|New/);
  await files.getByRole('button', { name: /^(Schließen|Close)$/ }).click();
  await expect(item).not.toContainText(/2 neu|2 new/);
  await expect.poll(newInNav).toBe(before - 2);
  // The files are in the folder, beside what was there.
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  for (const name of ['beach.jpg', 'hike.jpg', 'private.txt']) await expect(page.locator('tbody .name').getByText(name, { exact: true })).toBeVisible();
  await v.context().close();
});

// #305: the saved name `secret-contract (1).pdf` would tell the visitor that the folder holds `secret-contract.pdf`.
test('the visitor sees the name they sent, not the keep-both name of a taken one', async ({ page, browser, baseURL }, info) => {
  const dir = `request-probe-${tag(info)}`;
  await setup(page, dir, { 'secret-contract.pdf': 'owner only' });
  const address = await createRequest(page, dir, `Contracts ${tag(info)}`);

  const v = await visitor(browser, info, baseURL!);
  await v.goto(address);
  await v.getByTestId('request-picker').setInputFiles([{ name: 'secret-contract.pdf', mimeType: 'application/pdf', buffer: Buffer.from('visitor') }]);
  const yours = v.getByRole('list', { name: 'Your files' });
  await expect(yours.getByRole('listitem').filter({ hasText: 'secret-contract.pdf' })).toContainText('Sent');
  await v.reload();
  await expect(yours.getByRole('listitem')).toHaveCount(1);
  await expect(yours.getByRole('listitem').filter({ hasText: 'secret-contract.pdf' })).toContainText('Sent');
  await expect(v.locator('body')).not.toContainText('secret-contract (1).pdf');
  await v.context().close();
});

test('a request with a file limit refuses the next file; a revoked request says it is closed', async ({ page, browser, baseURL }, info) => {
  const dir = `request-limit-${tag(info)}`;
  await setup(page, dir);
  const title = `One file ${tag(info)}`;
  const address = await createRequest(page, dir, title, async (d) => {
    await d.getByLabel(/Höchstens so viele Dateien|Maximum number of files/).fill('1');
  });

  const v = await visitor(browser, info, baseURL!);
  await v.goto(address);
  await expect(v.getByTestId('files-left')).toHaveText('1');
  await v.getByTestId('request-picker').setInputFiles([{ name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('1') }]);
  await expect(v.getByRole('list', { name: 'Your files' }).getByRole('listitem').filter({ hasText: 'first.txt' })).toContainText('Sent');
  await expect(v.getByTestId('files-left')).toHaveText('0');
  await v.getByTestId('request-picker').setInputFiles([{ name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('2') }]);
  await expect(v.getByRole('alert')).toHaveText('Not sent: This file request accepts no more files.');

  const item = page.getByRole('list', { name: /Dateianfragen|File requests/ }).getByRole('listitem').filter({ hasText: title });
  await item.getByRole('button', { name: new RegExp(`(${escape(title)} widerrufen|Revoke ${escape(title)})`) }).click();
  await expect(item).toContainText(/Widerrufen|Revoked/);
  await expect(item.getByRole('textbox')).toHaveCount(0);
  await v.reload();
  await expect(v.getByText('This file request can’t be opened')).toBeVisible();
  await expect(v.getByText('The person who sent you this link has closed it.')).toBeVisible();
  await expect(v.getByTestId('request-picker')).toHaveCount(0);
  await v.context().close();
});

// #304: an unfinished upload of a visitor: the tus creation of HELD bytes and half of them, through the visitor's own
// session. It holds HELD bytes of the owner's quota (half staged, half reserved).
const HELD = 400_000;
async function unfinished(v: Page, address: string, name: string) {
  await v.goto(address);
  await expect(v.getByText('You have not sent any files yet.')).toBeVisible();
  const token = new URL(address).pathname.split('/')[2]!;
  const tus = { origin: new URL(address).origin, 'tus-resumable': '1.0.0' };
  const c = await v.request.post(`/r/${token}/uploads`, { headers: { ...tus, 'upload-length': String(HELD),
    'upload-metadata': `name ${Buffer.from(name).toString('base64')}` } });
  expect(c.status()).toBe(201);
  const p = await v.request.patch(c.headers().location!, { data: Buffer.alloc(HELD / 2, 1),
    headers: { ...tus, 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' } });
  expect(p.status()).toBe(204);
}

/** The storage page's "uploads in progress" figure. */
async function uploadsFigure(page: Page): Promise<string> {
  await page.goto('/storage');
  const figure = page.locator('.storage-breakdown div').filter({ hasText: /Laufende Uploads|Uploads in progress/ }).locator('dd');
  await expect(figure).toBeVisible();
  return (await figure.textContent())!.trim();
}

test('revoking a request drops a visitor\'s unfinished upload: the uploads figure is back and the owner uploads', async ({ page, browser, baseURL }, info) => {
  const dir = `request-halfway-${tag(info)}`;
  await setup(page, dir);
  const before = await uploadsFigure(page);
  const title = `Halfway ${tag(info)}`;
  const address = await createRequest(page, dir, title);
  // A quota that leaves 100 kB once the visitor's upload holds its bytes: what the home uses now, what the owner's own
  // open uploads still reserve, the visitor's upload and 100 kB (testuser is the admin and sets their own).
  const { csrfToken, id } = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string; id: string };
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  const used = (await (await page.request.get('/api/v1/storage')).json() as { home: { usage: { total: number } } }).home.usage.total;
  const own = (await (await page.request.get('/api/v1/uploads')).json() as { items: { length: number; offset: number }[] }).items
    .reduce((n, u) => n + u.length - u.offset, 0);
  const setQuota = (quotaBytes: number | null) => page.request.put(`/api/v1/admin/members/${id}/quota`, { headers, data: { quotaBytes } });
  expect((await setQuota(used + own + HELD + 100_000)).status()).toBe(200);
  try {
    const v = await visitor(browser, info, baseURL!);
    await unfinished(v, address, 'half.bin');
    expect(await uploadsFigure(page)).not.toBe(before);

    await openRequests(page);
    const item = page.getByRole('list', { name: /Dateianfragen|File requests/ }).getByRole('listitem').filter({ hasText: title });
    await expect(item).toContainText(/ein unfertiger Upload|one unfinished upload/);
    await item.getByRole('button', { name: new RegExp(`(${escape(title)} widerrufen|Revoke ${escape(title)})`) }).click();
    await expect(item).toContainText(/Widerrufen|Revoked/);
    await expect(item).not.toContainText(/unfertig|unfinished/);
    expect(await uploadsFigure(page)).toBe(before);

    // 300 kB fit only because the visitor's upload no longer holds the quota.
    await page.goto(`/home/${encodeURIComponent(dir)}`);
    await page.getByTestId('upload-input').setInputFiles({ name: 'mine.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(300_000, 2) });
    await expect(page.locator('tbody .name').getByText('mine.bin', { exact: true })).toBeVisible();
    await v.context().close();
  } finally { expect((await setQuota(null)).status()).toBe(200); }
});

test('the owner discards a visitor\'s unfinished uploads and the request stays open', async ({ page, browser, baseURL }, info) => {
  const dir = `request-discard-${tag(info)}`;
  await setup(page, dir);
  const title = `Dropping ${tag(info)}`;
  const address = await createRequest(page, dir, title);
  const v = await visitor(browser, info, baseURL!);
  await unfinished(v, address, 'first.bin');

  await page.reload();
  const item = page.getByRole('list', { name: /Dateianfragen|File requests/ }).getByRole('listitem').filter({ hasText: title });
  await expect(item).toContainText(/ein unfertiger Upload|one unfinished upload/);
  await item.getByRole('button', { name: new RegExp(`(Unfertige Uploads an ${escape(title)} verwerfen|Discard the unfinished uploads to ${escape(title)})`) }).click();
  await expect(item).not.toContainText(/unfertig|unfinished/);
  await expect(item.getByRole('button', { name: /^(Unfertige|Discard the unfinished)/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Neue Dateianfrage|New file request/ })).toBeFocused();
  // Still open: the visitor sends a whole file now.
  await v.reload();
  await v.getByTestId('request-picker').setInputFiles([{ name: 'whole.txt', mimeType: 'text/plain', buffer: Buffer.from('whole') }]);
  await expect(v.getByRole('list', { name: 'Your files' }).getByRole('listitem').filter({ hasText: 'whole.txt' })).toContainText('Sent');
  await v.context().close();
});

// #311: the Files dialog leads to what came in: a name opens the request's folder with that file selected, and
// "Open folder" opens the folder itself.
test('a received file in the Files dialog opens the request\'s folder with it selected', async ({ page, browser, baseURL }, info) => {
  const dir = `request-open-${tag(info)}`;
  await setup(page, dir, { 'Anderes.txt': 'owner only' });
  const title = `Belege ${tag(info)}`;
  const address = await createRequest(page, dir, title);
  const v = await visitor(browser, info, baseURL!);
  await v.goto(address);
  await v.getByTestId('request-picker').setInputFiles([{ name: 'Quittung.txt', mimeType: 'text/plain', buffer: Buffer.from('12,50') }]);
  await expect(v.getByRole('list', { name: 'Your files' }).getByRole('listitem').filter({ hasText: 'Quittung.txt' })).toContainText('Sent');
  await v.context().close();

  const row = (name: string) => page.locator('tbody tr').filter({ has: page.locator('.name').getByText(name, { exact: true }) });
  const showFiles = async () => {
    await page.goto('/requests');
    const item = page.getByRole('list', { name: /Dateianfragen|File requests/ }).getByRole('listitem').filter({ hasText: title });
    await item.getByRole('button', { name: new RegExp(`(Dateien anzeigen, die über ${escape(title)}|Show the files received through ${escape(title)})`) }).click();
    const files = page.getByRole('dialog', { name: new RegExp(escape(title)) });
    await expect(files.getByRole('listitem')).toHaveCount(1);
    return files;
  };

  let files = await showFiles();
  await files.getByRole('link', { name: 'Quittung.txt', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/home/${encodeURIComponent(dir)}\\?select=`));
  await expect(row('Quittung.txt')).toHaveAttribute('aria-selected', 'true');
  await expect(row('Quittung.txt')).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  files = await showFiles();
  await files.getByRole('link', { name: /^(Ordner öffnen|Open folder)$/ }).click();
  await expect(page).toHaveURL(new RegExp(`/home/${encodeURIComponent(dir)}$`));
  await expect(row('Anderes.txt')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
