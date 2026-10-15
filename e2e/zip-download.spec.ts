import { expect, test, type Download, type Locator, type Page, type TestInfo } from '@playwright/test';
import yauzl from 'yauzl';

// #139: a folder or a selection downloads as one streamed ZIP. The archive is read with yauzl, an independent reader.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;

async function setup(page: Page, dir: string, files: Record<string, string>, folders: string[]) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  for (const p of [`/${dir}`, ...folders.map((f) => `/${dir}/${f}`)]) {
    expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: p } })).status()).toBe(201);
  }
  for (const [name, text] of Object.entries(files)) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(text) });
    expect(r.status()).toBe(201);
  }
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(page.locator('tbody tr').first()).toBeVisible();
}
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });

/** Every entry of the downloaded archive with its content (folders end in `/` and have none). */
async function unpack(d: Download): Promise<Record<string, string>> {
  const file = await d.path();
  const zip = await new Promise<yauzl.ZipFile>((res, rej) => yauzl.open(file, { lazyEntries: true }, (e, z) => (e ? rej(e) : res(z!))));
  const out: Record<string, string> = {};
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', () => resolve());
    zip.on('entry', (entry: yauzl.Entry) => {
      if (entry.fileName.endsWith('/')) { out[entry.fileName] = ''; zip.readEntry(); return; }
      zip.openReadStream(entry, (e, s) => {
        if (e) return reject(e);
        let text = '';
        s.setEncoding('utf8');
        s.on('data', (c: string) => { text += c; });
        s.on('error', reject);
        s.on('end', () => { out[entry.fileName] = text; zip.readEntry(); });
      });
    });
    zip.readEntry();
  });
  return out;
}

test('selecting two files and a folder and pressing Download gives a ZIP of exactly the selection', async ({ page }, info) => {
  const dir = `zip-sel-${tag(info)}`;
  await setup(page, dir, { 'eins.txt': 'eins', 'zwei Ü.txt': 'zwei', 'nicht.txt': 'nicht gewählt', 'Ordner/drin.txt': 'drin' },
    ['Ordner', 'Ordner/leer']);
  for (const name of ['eins.txt', 'zwei Ü.txt', 'Ordner']) await row(page, name).getByRole('checkbox').check();
  const bar = page.getByRole('group', { name: /Aktionen für die Auswahl|Actions for the selection/ });
  const [d] = await Promise.all([page.waitForEvent('download'), bar.getByRole('link', { name: /^(Herunterladen|Download)$/ }).click()]);
  expect(d.suggestedFilename()).toBe(`${dir}.zip`);
  expect(await unpack(d)).toEqual({
    'eins.txt': 'eins', 'zwei Ü.txt': 'zwei', 'Ordner/': '', 'Ordner/drin.txt': 'drin', 'Ordner/leer/': '',
  });
  await expect(page).toHaveURL(new RegExp(`/home/${dir}$`)); // the page stays
});

test('a folder downloads as a ZIP from its row menu; one selected file downloads as itself', async ({ page }, info) => {
  const dir = `zip-menu-${tag(info)}`;
  await setup(page, dir, { 'Fotos/a.txt': 'A', 'Fotos/tief/b.txt': 'B', 'c.txt': 'C' }, ['Fotos', 'Fotos/tief']);
  await row(page, 'Fotos').getByRole('button', { name: /(Aktionen für|Actions for) Fotos/ }).click();
  const [d] = await Promise.all([page.waitForEvent('download'),
    page.getByRole('menu').getByRole('menuitem', { name: /^(Herunterladen|Download)$/ }).click()]);
  expect(d.suggestedFilename()).toBe('Fotos.zip');
  expect(await unpack(d)).toEqual({ 'Fotos/': '', 'Fotos/a.txt': 'A', 'Fotos/tief/': '', 'Fotos/tief/b.txt': 'B' });

  await row(page, 'c.txt').getByRole('checkbox').check();
  const bar = page.getByRole('group', { name: /Aktionen für die Auswahl|Actions for the selection/ });
  const [single] = await Promise.all([page.waitForEvent('download'), bar.getByRole('link', { name: /^(Herunterladen|Download)$/ }).click()]);
  expect(single.suggestedFilename()).toBe('c.txt');
});
