import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { randomBytes } from 'node:crypto';

// #158: Files is an installable PWA (manifest, icons, a service worker for the app shell) and a Web Share Target.
// Both projects share one server and data dir; every test works in its own folder named after the project and test.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const crumbs = (page: Page) => page.getByRole('navigation', { name: /Pfad|Path/ });

/** Signs in (the fake IdP answers at once) and waits until the service worker controls the page. */
async function signedInWithWorker(page: Page): Promise<void> {
  await page.goto('/');
  await expect(crumbs(page)).toBeVisible();
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe(new URL('/', page.url()).href);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

test('the manifest is served, linked and valid, with installable icons and the share target', async ({ page }) => {
  await page.goto('/');
  await expect(crumbs(page)).toBeVisible();
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest.webmanifest');
  const r = await page.request.get(href!);
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toContain('application/manifest+json');
  const m = await r.json();
  expect(m).toMatchObject({ name: 'Files', short_name: 'Files', start_url: '/home', scope: '/', display: 'standalone',
    share_target: { action: '/api/v1/share-target', method: 'POST', enctype: 'multipart/form-data',
      params: { files: [{ name: 'files', accept: ['*/*'] }] } } });
  const icons = m.icons as { src: string; sizes: string; type: string; purpose?: string }[];
  expect(icons.map((i) => `${i.sizes} ${i.purpose ?? 'any'}`)).toEqual(expect.arrayContaining(['192x192 any', '512x512 any', '512x512 maskable']));
  for (const icon of icons) {
    const img = await page.request.get(icon.src);
    expect(img.status(), icon.src).toBe(200);
    expect(img.headers()['content-type'], icon.src).toBe(icon.type);
  }
  // The browser's own reading of the manifest: no parse errors and nothing that blocks installing.
  const cdp = await page.context().newCDPSession(page);
  const parsed = await cdp.send('Page.getAppManifest');
  expect(parsed.url).toBe(new URL('/manifest.webmanifest', page.url()).href);
  expect(parsed.errors).toEqual([]);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  expect(installabilityErrors).toEqual([]);
});

test('the service worker registers and the app shell loads offline with a clear offline state for data', async ({ page, context }) => {
  await signedInWithWorker(page);
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.locator('.app-title')).toHaveText(/^(Dateien|Files)$/);
    await expect(page.getByRole('status').filter({ hasText: /offline/ })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(/Keine Verbindung zum Shard|No connection to the shard/);
  } finally {
    await context.setOffline(false);
  }
  // Back online, the same shell loads the data again.
  await page.reload();
  await expect(crumbs(page)).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /offline/ })).toHaveCount(0);
});

test('a multipart share leads to the folder picker; the file is uploaded there and listed with identical content', async ({ page }, info) => {
  const dir = `share-${tag(info)}`;
  await signedInWithWorker(page);
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const origin = new URL(page.url()).origin;
  expect((await page.request.post('/api/v1/sources/home/mkdir',
    { headers: { 'x-csrf-token': csrfToken, origin }, data: { path: `/${dir}` } })).status()).toBe(201);

  // What the share sheet does: a multipart POST navigation to the manifest's action, without a CSRF token.
  const data = randomBytes(256 * 1024 + 7);
  await page.evaluate(({ b64 }) => {
    const form = document.createElement('form');
    form.method = 'post'; form.action = '/api/v1/share-target'; form.enctype = 'multipart/form-data';
    const input = document.createElement('input');
    input.type = 'file'; input.name = 'files';
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'IMG_0001.jpg', { type: 'image/jpeg' }));
    input.files = dt.files;
    form.append(input); document.body.append(form); form.submit();
  }, { b64: data.toString('base64') });

  await expect(page).toHaveURL(/\/share-target\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: /Geteilte Dateien speichern|Save shared files/ })).toBeVisible();
  await expect(page.getByTestId('share-files')).toContainText('IMG_0001.jpg');
  const picker = page.getByRole('navigation', { name: /Zielordner|Target folder/ });
  await expect(picker).toBeVisible();
  await page.getByRole('button', { name: dir, exact: true }).click();
  await expect(picker.getByRole('button', { name: dir, exact: true })).toHaveAttribute('aria-current', 'location');
  await page.getByRole('button', { name: /^(Hier speichern|Save here)$/ }).click();

  await expect(page).toHaveURL(new RegExp(`/home/${dir}$`));
  await expect(page.getByRole('link', { name: 'IMG_0001.jpg', exact: true })).toBeVisible();
  const got = await page.request.get(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/IMG_0001.jpg`)}`);
  expect(got.status()).toBe(200);
  expect(Buffer.compare(await got.body(), data)).toBe(0);

  // The share is gone from the browser once saved: its page now says there is nothing to save.
  await page.goBack();
  await expect(page.getByText(/Hier ist nichts zu speichern|Nothing to save here/)).toBeVisible();
});

test('the share page without a share explains it and offers the way home', async ({ page }) => {
  await page.goto('/share-target');
  await expect(page.getByText(/Hier ist nichts zu speichern|Nothing to save here/)).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: /Mein Speicher|My storage/ }).click();
  await expect(page).toHaveURL(/\/home$/);
});
