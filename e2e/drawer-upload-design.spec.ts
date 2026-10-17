import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import { crc32, deflateSync } from 'node:zlib';

// #242: the details drawer, its versions, the lightbox and the upload panel against the design guide. The drawer says
// what a file is in words and where it lies from "My storage" (D1), tells versions apart to the second with a download
// icon (D2), has a head with an X and starts with the focus on its title (D3), and shows "DETAILS" over the bare name,
// two lines at most (D5). The lightbox opened from the gallery steps through images only, on a `--bg` well (D4). The
// upload panel's row actions are 32 px icon buttons inline at the row's right edge (U1), a failed row says "Failed"
// only (U2), the head counts the uploads with the overall state (U4) and the track is `--border-cool` (U5). Each check
// runs on desktop and phone (the two projects) and in both themes.

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const mobile = (info: TestInfo) => info.project.name.startsWith('mobile');
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const box = async (l: Locator) => (await l.boundingBox())!;
const style = (l: Locator, prop: string) => l.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
const MONO = /IBM Plex Mono/;

async function headers(page: Page) {
  const me = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin };
}
async function putSettings(page: Page, locale: 'de-du' | null, theme: Scheme | 'system') {
  const r = await page.request.put('/api/v1/settings', { data: { locale, theme }, headers: await headers(page) });
  expect(r.status(), await r.text()).toBe(200);
}
/** Folders this spec made in the home root; removed after each test so other specs' rows stay in a phone's window. */
const created: string[] = [];
async function mkdir(page: Page, path: string) {
  const r = await page.request.post('/api/v1/sources/home/mkdir', { data: { path }, headers: await headers(page) });
  expect([201, 409]).toContain(r.status());
  created.push(path);
}
async function putFile(page: Page, path: string, body: Buffer | string = 'x') {
  const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=replace`, {
    data: typeof body === 'string' ? Buffer.from(body) : body, headers: { ...await headers(page), 'content-type': 'application/octet-stream' } });
  expect(r.status(), await r.text()).toBeLessThan(300);
}
/** A CSS colour expression as the page computes it in the current theme. */
async function resolved(page: Page, css: string): Promise<string> {
  return page.evaluate((value) => {
    const probe = document.createElement('div');
    probe.style.color = value;
    document.body.append(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, css);
}
/** A `w`×`h` RGB PNG in one colour. */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
async function openDetails(page: Page, name: string): Promise<Locator> {
  await row(page, name).getByRole('button', { name: /^Aktionen für / }).click();
  await page.getByRole('menuitem', { name: /^Details$/ }).click();
  const drawer = page.getByRole('dialog', { name: `Details ${name}`, exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
}
async function closeDrawer(page: Page, drawer: Locator) {
  await drawer.locator('.app-dialog-head').getByRole('button', { name: 'Schließen', exact: true }).click();
  await expect(drawer).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await putSettings(page, null, 'system');
  if (created.length === 0) return;
  const paths = created.splice(0);
  const h = await headers(page);
  const r = await page.request.post('/api/v1/sources/home/delete', { data: { paths }, headers: h });
  expect(r.status(), await r.text()).toBe(204);
  // Purged from the trash too: another spec restores whatever the trash holds, which would bring them back to the root.
  const { items } = await (await page.request.get('/api/v1/trash')).json() as { items: { id: string; originalPath: string }[] };
  const ids = items.filter((i) => paths.includes(i.originalPath)).map((i) => i.id);
  expect(ids).toHaveLength(paths.length);
  const p = await page.request.post('/api/v1/trash/delete', { data: { ids }, headers: h });
  expect(p.status(), await p.text()).toBe(204);
});

const LONG = 'Abrechnung der Hausgemeinschaft für das ganze Jahr 2026 mit allen Belegen, Quittungen und Nachweisen der Nebenkosten.txt';
const KINDS: [name: string, body: Buffer | string, kind: string][] = [
  ['Bericht.pdf', '%PDF-1.4\n', 'PDF-Dokument'],
  ['Notiz.txt', 'eins', 'Textdatei'],
  ['Foto.png', png(4, 4, [200, 40, 40]), 'Bild (PNG)'],
  ['Archiv.zip', 'PK', 'ZIP-Archiv'],
  ['Messung.xyz', 'x', 'Datei (.xyz)'],
];

for (const scheme of SCHEMES) {
  test(`${scheme}: the drawer names the kind and the place in words, has a head with X and the name as a clamped title (D1, D3, D5)`, async ({ page }, info) => {
    const dir = `Projekte-${scheme}-${tag(info)}`;
    await mkdir(page, `/${dir}`);
    for (const [name, body] of KINDS) await putFile(page, `/${dir}/${name}`, body);
    await putFile(page, `/${dir}/${LONG}`, 'lang');
    await putSettings(page, 'de-du', scheme);
    await page.goto(`/home/${encodeURIComponent(dir)}`);
    await expect(row(page, 'Bericht.pdf')).toBeVisible();

    for (const [name, , kind] of KINDS) {
      const drawer = await openDetails(page, name);
      const facts = drawer.locator('.details-facts');
      await expect(facts.locator('dt').first()).toHaveText('Art');
      await expect(facts.locator('dd').first()).toHaveText(kind);
      await expect(facts.locator('dd').last()).toHaveText(`Mein Speicher › ${dir}`);
      await closeDrawer(page, drawer);
    }

    const drawer = await openDetails(page, LONG);
    // D5: "DETAILS" as the label over the name; the name alone is the title, two lines at most, the whole name its `title`.
    const label = drawer.locator('.app-dialog-head .fs-label');
    const title = drawer.getByRole('heading', { level: 2 });
    await expect(label).toHaveText('Details');
    expect(await style(label, 'text-transform')).toBe('uppercase');
    await expect(title).toHaveText(LONG);
    await expect(title).toHaveAttribute('title', LONG);
    expect((await box(label)).y + (await box(label)).height).toBeLessThanOrEqual((await box(title)).y + 0.5);
    const lineHeight = parseFloat(await style(title, 'line-height'));
    expect((await box(title)).height, 'two lines at most').toBeLessThanOrEqual(2 * lineHeight + 1);
    expect(await title.evaluate((el) => el.scrollHeight > el.clientHeight), 'the long name is clamped').toBe(true);
    // D3: the focus starts on the title, without a ring; the head has the X at its right edge, on the title's row.
    await expect(title).toBeFocused();
    expect(await style(title, 'outline-style')).toBe('none');
    const x = drawer.locator('.app-dialog-head').getByRole('button', { name: 'Schließen', exact: true });
    await expect(x.locator('.icon-close')).toBeVisible();
    expect((await x.innerText()).trim()).toBe('');
    const xBox = await box(x);
    const head = await box(drawer.locator('.app-dialog-head'));
    expect(xBox.x + xBox.width).toBeGreaterThan(head.x + head.width - 1);
    expect(xBox.width).toBe(mobile(info) ? 44 : 32);
    // The head ends in a hairline, like Calendar's modal header.
    expect(await style(drawer.locator('.app-dialog-head'), 'border-bottom-color')).toBe(await resolved(page, 'var(--border)'));
    expect(await style(drawer.locator('.app-dialog-head'), 'border-bottom-width')).toBe('1px');
    // Only one way to close in the drawer: the X (Esc still works).
    await expect(drawer.getByRole('button', { name: 'Schließen', exact: true })).toHaveCount(1);
    await x.click();
    await expect(drawer).toHaveCount(0);
    // The focus goes back to the item's row, as after Esc.
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('tr')?.textContent ?? document.activeElement?.tagName))
      .toContain(LONG);
  });

  test(`${scheme}: versions read to the second and download from an icon button (D2)`, async ({ page }, info) => {
    const dir = `Versionen-${scheme}-${tag(info)}`;
    await mkdir(page, `/${dir}`);
    // Three replacements within one minute: each leaves the previous content as a version.
    for (const text of ['eins', 'zwei', 'drei', 'vier']) {
      await putFile(page, `/${dir}/Plan.txt`, text);
      await page.waitForTimeout(1100);
    }
    await putSettings(page, 'de-du', scheme);
    await page.goto(`/home/${encodeURIComponent(dir)}`);
    const drawer = await openDetails(page, 'Plan.txt');
    const versions = drawer.getByRole('list', { name: 'Versionen' }).getByRole('listitem');
    await expect(versions).toHaveCount(3);
    const dates = await versions.locator('.share-name').allInnerTexts();
    for (const d of dates) expect(d).toMatch(/^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}:\d{2}$/);
    expect(new Set(dates).size, 'every version reads differently').toBe(3);
    for (const v of await versions.all()) {
      const link = v.getByRole('link', { name: /^Version vom .* herunterladen$/ });
      await expect(link.locator('.icon-download')).toBeVisible();
      expect((await link.innerText()).trim()).toBe('');
      const b = await box(link);
      expect(b.width).toBe(mobile(info) ? 44 : 32);
      expect(b.height).toBe(mobile(info) ? 44 : 32);
      // Restore stays a word: it changes the file.
      await expect(v.getByRole('button', { name: /^Version vom .* wiederherstellen$/ })).toHaveText('Wiederherstellen');
    }
  });

  test(`${scheme}: the lightbox from the gallery steps through images only, on a --bg well (D4)`, async ({ page }, info) => {
    const dir = `Galerie-${scheme}-${tag(info)}`;
    await mkdir(page, `/${dir}`);
    await putFile(page, `/${dir}/a-rot.png`, png(64, 48, [200, 40, 40]));
    await putFile(page, `/${dir}/b-gruen.png`, png(48, 64, [40, 160, 60]));
    await putFile(page, `/${dir}/b-notiz.txt`, 'Notiz');
    await putFile(page, `/${dir}/c-blau.png`, png(60, 60, [40, 60, 200]));
    await putSettings(page, 'de-du', scheme);
    await page.goto(`/home/${encodeURIComponent(dir)}`);
    await expect(row(page, 'b-notiz.txt')).toBeVisible();

    // The list keeps stepping through every file.
    await page.getByRole('link', { name: 'b-gruen.png', exact: true }).click();
    const lightbox = (name: string) => page.getByRole('dialog', { name, exact: true });
    await expect(lightbox('b-gruen.png').locator('.preview-position')).toHaveText('2 von 4');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByRole('group', { name: 'Ansicht' }).getByRole('button', { name: 'Galerie' }).click();
    const gallery = page.getByRole('list', { name: 'Galerie' });
    await gallery.getByRole('button', { name: 'b-gruen.png', exact: true }).click();
    await expect(lightbox('b-gruen.png').locator('.preview-position')).toHaveText('2 von 3');
    const body = lightbox('b-gruen.png').locator('.preview-body');
    expect(await style(body, 'background-color')).toBe(await resolved(page, 'var(--bg)'));
    expect(await style(lightbox('b-gruen.png'), 'background-color')).toBe(await resolved(page, 'var(--surface)'));
    await page.keyboard.press('ArrowRight');
    await expect(lightbox('c-blau.png').locator('.preview-position')).toHaveText('3 von 3');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(lightbox('a-rot.png').locator('.preview-position')).toHaveText('1 von 3');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test(`${scheme}: upload rows carry 32 px icon actions at their right edge, the head counts, a failure says only "Failed" (U1, U2, U4, U5)`, async ({ page }, info) => {
    const dir = `Hochladen-${scheme}-${tag(info)}`;
    await mkdir(page, `/${dir}`);
    await putSettings(page, 'de-du', scheme);
    await page.goto(`/home/${encodeURIComponent(dir)}`);
    await expect(page.getByRole('navigation', { name: 'Pfad' })).toBeVisible();
    // The shard never answers: the first file stays running, the others wait.
    // Held requests are aborted at the end, never let through: a creation let through late would leave an upload on
    // the server that the next page lists as unfinished (#233).
    const hung: Route[] = [];
    await page.route('**/api/v1/uploads**', (route) => (route.request().method() === 'GET' ? route.continue() : void hung.push(route)));
    const names = ['eins.txt', 'zwei.txt', 'drei.txt'];
    await page.getByTestId('upload-input').setInputFiles(names.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })));
    const panel = page.getByTestId('upload-panel');
    const item = (name: string) => panel.locator('.upload-item', { has: page.locator('.upload-name').getByText(name, { exact: true }) });
    await expect(item('eins.txt')).toHaveAttribute('data-state', 'uploading');
    await expect(item('drei.txt')).toHaveAttribute('data-state', 'queued');

    // U4: the head says how many of how many, and that they are running.
    const heading = panel.getByRole('heading', { level: 2 });
    await expect(heading).toHaveText('Uploads · 0 von 3 · läuft');
    expect(await style(heading, 'text-transform')).toBe('none');

    const size = mobile(info) ? 44 : 32;
    for (const name of names) {
      const it = item(name);
      const pause = it.getByRole('button', { name: `Hochladen von ${name} pausieren`, exact: true });
      const cancel = it.getByRole('button', { name: `Hochladen von ${name} abbrechen`, exact: true });
      await expect(pause.locator('.icon-pause')).toBeVisible();
      await expect(cancel.locator('.icon-close')).toBeVisible();
      const n = await box(it.locator('.upload-name'));
      const r = await box(it);
      for (const b of [pause, cancel]) {
        expect((await b.innerText()).trim()).toBe('');
        const bb = await box(b);
        expect([bb.width, bb.height]).toEqual([size, size]);
        // Inline: on the name's row, never a line of its own.
        expect(bb.y).toBeLessThan(n.y + n.height);
        expect(bb.y + bb.height).toBeGreaterThan(n.y);
      }
      expect((await box(cancel)).x + size).toBeGreaterThan(r.x + r.width - 1);
      // U5: the track is the cool hairline.
      expect(await style(it.locator('.upload-bar'), 'background-color')).toBe(await resolved(page, 'var(--border-cool)'));
    }
    // Pause a waiting file: resume is the same icon button.
    await item('drei.txt').getByRole('button', { name: 'Hochladen von drei.txt pausieren' }).click();
    const resume = item('drei.txt').getByRole('button', { name: 'Hochladen von drei.txt fortsetzen', exact: true });
    await expect(resume.locator('.icon-resume')).toBeVisible();
    expect([(await box(resume)).width, (await box(resume)).height]).toEqual([size, size]);
    for (const name of names) await item(name).getByRole('button', { name: `Hochladen von ${name} abbrechen` }).click();
    await expect(heading).toHaveText('Uploads · 0 von 3 · abgeschlossen');
    await panel.getByRole('button', { name: 'Erledigte entfernen' }).click();
    await expect(panel).toHaveCount(0);

    // U2: a failed row is the name, "Fehlgeschlagen" in the UI face in danger, and the retry icon; the reason is in the summary only.
    for (const r of hung) await r.abort();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.route('**/api/v1/uploads**', (route) => route.abort('internetdisconnected'));
    await page.getByTestId('upload-input').setInputFiles({ name: 'kaputt.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
    const failed = item('kaputt.txt');
    await expect(failed).toHaveAttribute('data-state', 'failed', { timeout: 20_000 });
    const state = failed.locator('.upload-state');
    await expect(state).toHaveText('Fehlgeschlagen');
    expect(await style(state, 'color')).toBe(await resolved(page, 'var(--danger)'));
    expect(await style(state, 'font-family')).not.toMatch(MONO);
    const summary = page.getByTestId('upload-summary');
    const reason = (await summary.locator('li').innerText()).replace(/^kaputt\.txt: /, '');
    expect(reason.length).toBeGreaterThan(0);
    await expect(failed).not.toContainText(reason);
    const retry = failed.getByRole('button', { name: 'Hochladen von kaputt.txt erneut versuchen', exact: true });
    await expect(retry.locator('.icon-retry')).toBeVisible();
    expect((await retry.innerText()).trim()).toBe('');
    expect([(await box(retry)).width, (await box(retry)).height]).toEqual([size, size]);
    await expect(heading).toHaveText('Uploads · 0 von 1 · abgeschlossen');
    // The summary and the head keep their text buttons.
    await expect(summary.getByRole('button', { name: 'Alle erneut versuchen' })).toHaveText('Alle erneut versuchen');
    await panel.getByRole('button', { name: 'Erledigte entfernen' }).click();
  });
}
