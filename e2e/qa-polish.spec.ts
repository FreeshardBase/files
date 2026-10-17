import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openPlaces } from './places.ts';

// #236: the polish bundle from exploratory QA. Both projects share one server and one `testuser`; every test works in a
// folder named after the project and test. The cloud parts (P3 for a connection, P4, P10) are in qa-polish-cloud.spec.ts.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const crumbs = (page: Page) => page.getByRole('navigation', { name: /Pfad|Path/ });
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const APP = '(Dateien|Files)';

async function headersOf(page: Page) {
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
}
/** A folder `/<dir>` of the home with `files`, opened in the SPA. */
async function folderWith(page: Page, dir: string, files: Record<string, Buffer | string>) {
  await page.goto('/home');
  await expect(crumbs(page)).toBeVisible();
  const headers = await headersOf(page);
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  for (const [name, body] of Object.entries(files)) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(body) });
    expect(r.status(), await r.text()).toBe(201);
  }
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(crumbs(page)).toContainText(dir);
}
/** The rendered width of an element's text, from its text node (the box itself may be wider). */
const textWidth = (l: Locator) => l.evaluate((el) => {
  const r = document.createRange();
  r.selectNodeContents(el);
  return r.getBoundingClientRect().width;
});

/** A one-page PDF with a line of text, for its thumbnail. */
function pdf(line: string): Buffer {
  const stream = `BT /F1 20 Tf 20 120 Td (${line}) Tj ET`;
  const font = '<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources ${font} /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let out = '%PDF-1.4\n'; const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('#236 P1: runs of spaces in a name are shown as typed, in the list and in the details', async ({ page }, info) => {
  const dir = `p1-${tag(info)}`;
  await folderWith(page, dir, { 'a   b.txt': 'x', 'a b.txt': 'x' });
  // By the title: matching by text folds runs of spaces, so it would find both rows.
  const wide = page.locator('tbody .name-text[title="a   b.txt"]');
  const narrow = page.locator('tbody .name-text[title="a b.txt"]');
  await expect(wide).toBeVisible();
  // Two more spaces make the name wider; collapsed, both names would be the same width.
  expect(await textWidth(wide)).toBeGreaterThan(await textWidth(narrow) + 4);

  await page.locator('tbody tr', { has: page.locator('.name-text[title="a   b.txt"]') })
    .getByRole('button', { name: /Aktionen für|Actions for/ }).click();
  await page.getByRole('menuitem', { name: /^Details$/ }).click();
  const title = page.getByRole('dialog', { name: 'Details a   b.txt', exact: true }).getByRole('heading', { name: 'a   b.txt' });
  await expect(title).toBeVisible();
  expect(await title.evaluate((el) => getComputedStyle(el).whiteSpace)).toMatch(/^pre/);
});

test('#236 P3, P11: every page has a readable title, and the app is called "Dateien"', async ({ page }, info) => {
  const dir = `p3-${tag(info)}`;
  await folderWith(page, dir, { 'note.txt': 'x' });
  await expect(page).toHaveTitle(new RegExp(`^${dir} – ${APP}$`));
  await page.goto('/home');
  await expect(page).toHaveTitle(new RegExp(`^(Mein Speicher|My storage) – ${APP}$`));
  await openPlaces(page);
  await page.getByRole('navigation', { name: /Orte|Places/ }).getByRole('link', { name: /^(Zuletzt geändert|Recent)$/ }).click();
  await expect(page).toHaveTitle(new RegExp(`^(Zuletzt geändert|Recent) – ${APP}$`));
  for (const [path, name] of [['/trash', 'Papierkorb|Trash'], ['/settings', 'Einstellungen|Settings'], ['/shared', 'Für mich freigegeben|Shared with me'],
    ['/migrate', 'Auf den Shard umziehen|Move to the shard'], ['/no-such-page', 'Seite nicht gefunden|Page not found']] as const) {
    await page.goto(path);
    await expect(page).toHaveTitle(new RegExp(`^(${name}) – ${APP}$`));
  }
  // The installed app (manifest) and the page before the script has run are "Dateien", as the German UI calls it.
  const manifest = await (await page.request.get('/manifest.webmanifest')).json() as { name: string; short_name: string; lang: string };
  expect(manifest).toMatchObject({ name: 'Dateien', short_name: 'Dateien', lang: 'de' });
  expect(await (await page.request.get('/home')).text()).toContain('<title>Dateien</title>');
});

test('#236 P5: the details say what a file is in words and where it is by folder name, also at the top level', async ({ page }, info) => {
  const dir = `p5-${tag(info)}`;
  await folderWith(page, dir, { 'readme.txt': 'x' });
  await row(page, 'readme.txt').getByRole('button', { name: /Aktionen für|Actions for/ }).click();
  await page.getByRole('menuitem', { name: /^Details$/ }).click();
  const facts = page.getByRole('dialog', { name: 'Details readme.txt', exact: true }).locator('.details-facts');
  await expect(facts).toContainText(/Textdatei|Text file/);
  await expect(facts).not.toContainText('text/plain');
  await expect(facts.locator('dt', { hasText: /^(Ort|Location)$/ }).locator('xpath=following-sibling::dd[1]'))
    .toHaveText(new RegExp(`^(Mein Speicher|My storage) › ${dir}$`));
  await page.keyboard.press('Escape');

  // An item at the top level is in "My storage", never in "/".
  await page.goto('/home');
  const top = `p5-top-${tag(info)}.txt`;
  const headers = await headersOf(page);
  expect((await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${top}`)}&onCollision=replace`,
    { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from('x') })).status()).toBeLessThan(300);
  await page.goto(`/home?select=${encodeURIComponent(`/${top}`)}`);
  await expect(row(page, top)).toHaveAttribute('aria-selected', 'true');
  await row(page, top).getByRole('button', { name: /Aktionen für|Actions for/ }).click();
  await page.getByRole('menuitem', { name: /^Details$/ }).click();
  const topFacts = page.getByRole('dialog', { name: `Details ${top}`, exact: true }).locator('.details-facts');
  await expect(topFacts.locator('dt', { hasText: /^(Ort|Location)$/ }).locator('xpath=following-sibling::dd[1]'))
    .toHaveText(/^(Mein Speicher|My storage)$/);
});

test('#236 P6: a PDF thumbnail has a hairline frame', async ({ page }, info) => {
  const dir = `p6-${tag(info)}`;
  await folderWith(page, dir, { 'page.pdf': pdf('Hello') });
  const thumb = row(page, 'page.pdf').locator('img.row-thumb');
  await expect.poll(() => thumb.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
  const style = await thumb.evaluate((el) => { const s = getComputedStyle(el); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; });
  expect(style.style).toBe('solid');
  expect(style.width).toBeGreaterThanOrEqual(1);
});

test('#236 P9: the migration page starts where the other pages start', async ({ page }) => {
  await page.goto('/recent');
  await expect(page.getByRole('heading', { name: /^(Zuletzt geändert|Recent)$/ })).toBeVisible();
  const x = await page.locator('section.page').first().evaluate((el) => el.getBoundingClientRect().x);
  await page.goto('/migrate');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await page.locator('section.page').first().evaluate((el) => el.getBoundingClientRect().x)).toBe(x);
});

test('#236 P12: the app-password dialog keeps its title in sight on a short window', async ({ page }) => {
  // Lower than the dialog, so the dialog has to scroll.
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 280 });
  await page.goto('/settings');
  await page.getByRole('textbox', { name: /Gerät oder Programm|Device or program/ }).fill('Short window');
  await page.getByRole('button', { name: /App-Passwort erstellen|Create app password/ }).click();
  const d = page.getByRole('dialog', { name: /App-Passwort für „Short window“|App password for “Short window”/ });
  const title = d.getByRole('heading', { name: /App-Passwort für „Short window“|App password for “Short window”/ });
  await expect(title).toBeInViewport({ ratio: 1 });
  // Scrolled to the end of the dialog, its title still shows; nothing of the dialog is out of reach.
  await page.locator('.app-dialog-scrim').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(d.getByRole('button', { name: /^(Fertig|Done)$/ })).toBeInViewport();
  await expect(title).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Escape');
  const headers = await headersOf(page);
  const { items } = await (await page.request.get('/api/v1/app-passwords')).json() as { items: { id: string; label: string }[] };
  for (const i of items.filter((x) => x.label === 'Short window')) await page.request.delete(`/api/v1/app-passwords/${i.id}`, { headers });
});

test('#236 P14, m16: on a phone there is no keyboard-help button and a long name takes two lines over its size', async ({ page, isMobile }, info) => {
  test.skip(!isMobile, 'phone only');
  const long = `${'Langer Dateiname '.repeat(14)}.txt`;
  const dir = `m16-${tag(info)}`;
  await folderWith(page, dir, { [long]: 'x' });
  await expect(page.getByRole('button', { name: /Tastenkürzel|Keyboard shortcuts/ })).toBeHidden();
  const name = row(page, long).locator('.name-text');
  const lines = await name.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  expect(lines).toBeLessThanOrEqual(2);
  const nameBottom = await name.evaluate((el) => el.getBoundingClientRect().bottom);
  expect(await row(page, long).locator('td.size').evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(nameBottom - 1);
});

test('#236 P15: a quota that is not a size is announced and marks its field invalid', async ({ page, browser, baseURL }) => {
  // A member is listed once they have signed in.
  const ctx = await browser.newContext({ baseURL });
  await (await ctx.newPage()).goto('/auth/login?login_hint=member');
  await ctx.close();
  await page.goto('/members');
  await expect(page.getByRole('heading', { name: /^(Mitglieder|Members)$/ })).toBeVisible();
  const r = page.locator('tbody tr', { hasText: 'member@example.com' });
  const amount = r.getByRole('textbox', { name: /Speicherlimit für Test Member|Storage limit for Test Member/ });
  await amount.fill('viel');
  await r.getByRole('button', { name: /Speicherlimit für Test Member festlegen|Set the storage limit for Test Member/ }).click();
  await expect(amount).toHaveAttribute('aria-invalid', 'true');
  const alert = r.getByRole('alert');
  await expect(alert).toHaveText(/Gib eine Größe ab 0 ein|Geben Sie eine Größe ab 0 ein|Enter a size of 0 or more/);
  await expect(amount).toHaveAttribute('aria-describedby', (await alert.getAttribute('id'))!);
});
