import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { crc32, deflateSync } from 'node:zlib';

// Both projects share one server and data dir; every test works in its own folder named after the project and test.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;

/** Creates `/<dir>` with the given files through the API, then opens it in the SPA. */
async function setup(page: Page, dir: string, files: Record<string, string | Buffer>) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  for (const [name, body] of Object.entries(files)) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(body) });
    expect(r.status()).toBe(201);
  }
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(page.locator('tbody tr')).toHaveCount(Object.keys(files).length);
}
const preview = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true });
const focusedRowName = (page: Page) => page.evaluate(() => document.activeElement?.closest('tr')?.querySelector('.name')?.textContent?.trim());
async function openPreview(page: Page, name: string): Promise<Locator> {
  await page.getByRole('link', { name, exact: true }).click();
  const d = preview(page, name);
  await expect(d).toBeVisible();
  return d;
}
async function close(page: Page, d: Locator) {
  await page.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
}

/** A `w`×`h` RGB PNG in the data colour. */
function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([0, 112, 128], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Half a second of a 440 Hz tone, 8 kHz mono 16-bit PCM. */
function wav(): Buffer {
  const n = 4000; const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 8000)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8, 'latin1');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** A two-page PDF: a blue square on page 1, a red one on page 2. */
function pdf(): Buffer {
  const pages = ['0 0 1 rg 20 20 160 160 re f', '1 0 0 rg 20 20 160 160 re f'];
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>', `<< /Length ${pages[0]!.length} >>\nstream\n${pages[0]}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 6 0 R >>', `<< /Length ${pages[1]!.length} >>\nstream\n${pages[1]}\nendstream`];
  let out = '%PDF-1.4\n'; const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A short WebM, recorded by the browser itself from a canvas (no binary fixture in the repo). */
async function webm(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 48;
    const g = c.getContext('2d')!;
    const rec = new MediaRecorder(c.captureStream(10), { mimeType: 'video/webm' });
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start();
    for (let i = 0; i < 6; i++) { g.fillStyle = i % 2 ? '#007080' : '#c8761f'; g.fillRect(0, 0, 64, 48); await new Promise((r) => setTimeout(r, 100)); }
    rec.stop(); await stopped;
    return Array.from(new Uint8Array(await new Blob(parts).arrayBuffer()));
  });
  return Buffer.from(bytes);
}

/** Whether the canvas has a pixel close to `rgb`, i.e. pdf.js really painted the page. */
const canvasHas = (d: Locator, rgb: [number, number, number]) => d.locator('canvas').evaluate((c: HTMLCanvasElement, [r, g, b]) => {
  const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i]! - r) < 40 && Math.abs(px[i + 1]! - g) < 40 && Math.abs(px[i + 2]! - b) < 40) return true;
  return false;
}, rgb);

test('each type opens in the overlay: image, video, audio, PDF, Markdown, text; others offer the download', async ({ page }, info) => {
  const dir = `preview-types-${tag(info)}`;
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible(); // the redirect to /home is done
  const video = await webm(page);
  await setup(page, dir, {
    'a-image.png': png(16, 12), 'b-video.webm': video, 'c-audio.wav': wav(), 'd-doc.pdf': pdf(),
    'e-notes.md': '# Title\n\nSome **bold** text.\n', 'f-plain.txt': 'just text', 'g-data.bin': 'xyz',
  });

  let d = await openPreview(page, 'a-image.png');
  const img = d.getByRole('img', { name: 'a-image.png' });
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(16);
  await close(page, d);

  d = await openPreview(page, 'b-video.webm');
  await expect.poll(() => d.locator('video').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
  await close(page, d);

  d = await openPreview(page, 'c-audio.wav');
  await expect.poll(() => d.locator('audio').evaluate((a: HTMLAudioElement) => a.readyState)).toBeGreaterThan(0);
  await close(page, d);

  d = await openPreview(page, 'd-doc.pdf');
  await expect(d.locator('canvas[data-rendered-page="1"]')).toBeVisible();
  expect(await canvasHas(d, [0, 0, 255])).toBe(true);
  await expect(d).toContainText(/Seite 1 von 2|Page 1 of 2/);
  await d.getByRole('button', { name: /^(Nächste Seite|Next page)$/ }).click();
  await expect(d.locator('canvas[data-rendered-page="2"]')).toBeVisible();
  expect(await canvasHas(d, [255, 0, 0])).toBe(true);
  await close(page, d);

  d = await openPreview(page, 'e-notes.md');
  await expect(d.locator('h1')).toHaveText('Title');
  await expect(d.locator('strong')).toHaveText('bold');
  await close(page, d);

  d = await openPreview(page, 'f-plain.txt');
  await expect(d.locator('pre')).toHaveText('just text');
  await close(page, d);

  d = await openPreview(page, 'g-data.bin');
  await expect(d).toContainText(/nicht anzeigen|can’t be shown/);
  await expect(d.getByRole('link', { name: /^(Herunterladen|Download)$/ })).toHaveAttribute('href', /download=1$/);
  await close(page, d);
});

test('Markdown with <script> and an <img onerror> renders inert: no element, no script, no request', async ({ page }, info) => {
  const dir = `preview-md-xss-${tag(info)}`;
  await setup(page, dir, {
    'evil.md': '# Notes\n\n<script>alert("script")</script>\n\nText <img src=x onerror="alert(\'img\')"> inline.\n\n'
      + '<div><img src=x onerror="alert(\'block\')"></div>\n\n![tracker](https://example.com/tracker.png)\n',
  });
  // Anything that runs, fails to load or is blocked by the CSP shows up here.
  const dialogs: string[] = []; const errors: string[] = []; const requests: string[] = [];
  page.on('dialog', (dlg) => { dialogs.push(dlg.message()); void dlg.dismiss(); });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (!r.url().startsWith(new URL(page.url()).origin)) requests.push(r.url()); else if (/\/x$/.test(r.url())) requests.push(r.url()); });

  const d = await openPreview(page, 'evil.md');
  await expect(d.locator('h1')).toHaveText('Notes');
  await expect(d).toContainText('<script>alert("script")</script>');
  await expect(d).toContainText('<img src=x onerror="alert(\'img\')">');
  await expect(d).toContainText(/Bild: tracker|Image: tracker/);
  await expect(d.locator('script, img, iframe, object, embed, [onerror]')).toHaveCount(0);
  await page.waitForTimeout(300); // give an image error event the chance to fire
  expect(dialogs).toEqual([]);
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
  await close(page, d);
});

test('a short Markdown note fills the 72ch column with left-aligned text instead of shrinking to its content (#310)', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const dir = `preview-md-column-${tag(info)}`;
  await setup(page, dir, { 'Kurz.md': '# Kurz\n\n- eins\n- zwei\n' });
  const d = await openPreview(page, 'Kurz.md');
  const md = d.locator('.markdown');
  await expect(md.locator('h1')).toHaveText('Kurz');
  const box = (await md.boundingBox())!;
  const h1 = (await md.locator('h1').boundingBox())!;
  const body = (await d.locator('.preview-body').boundingBox())!;
  expect(box.width).toBeGreaterThan(400);
  expect(Math.abs(h1.x - box.x)).toBeLessThan(1);
  // The column itself stays centred in the preview body.
  expect(Math.abs((box.x - body.x) - (body.x + body.width - box.x - box.width))).toBeLessThan(2);
  await close(page, d);
});

test('arrow keys switch files, the buttons too; Esc closes and focus returns to the row of the file shown last', async ({ page }, info) => {
  const dir = `preview-nav-${tag(info)}`;
  await setup(page, dir, { 'one.txt': '1', 'two.txt': '2', 'three.txt': '3' });
  // List order is by name: one, three, two.
  await page.locator('tbody tr', { has: page.getByText('one.txt', { exact: true }) }).focus();
  await page.keyboard.press('Enter');
  await expect(preview(page, 'one.txt').locator('pre')).toHaveText('1');
  await expect(preview(page, 'one.txt')).toContainText(/1 von 3|1 of 3/);
  await page.keyboard.press('ArrowRight');
  await expect(preview(page, 'three.txt').locator('pre')).toHaveText('3');
  await page.keyboard.press('ArrowRight');
  await expect(preview(page, 'two.txt').locator('pre')).toHaveText('2');
  await page.keyboard.press('ArrowRight'); // the last file: stays
  await expect(preview(page, 'two.txt')).toContainText(/3 von 3|3 of 3/);
  await page.keyboard.press('ArrowLeft');
  await expect(preview(page, 'three.txt')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await focusedRowName(page)).toBe('three.txt');

  // Tap/click: the name opens it, the buttons step, Close closes and focus goes back the same way.
  const d = await openPreview(page, 'one.txt');
  await d.getByRole('button', { name: /^(Weiter|Next)$/ }).click();
  await expect(preview(page, 'three.txt')).toBeVisible();
  await preview(page, 'three.txt').getByRole('button', { name: /^(Zurück|Previous)$/ }).click();
  await expect(preview(page, 'one.txt')).toBeVisible();
  await preview(page, 'one.txt').getByRole('button', { name: /^(Schließen|Close)$/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await focusedRowName(page)).toBe('one.txt');
});

test('on a phone a short text file still gets a full-height preview, not a half-height sheet at the bottom (#368)', async ({ page, isMobile }, info) => {
  test.skip(!isMobile, 'phone widths only');
  await setup(page, `short-${tag(info)}`, { 'short.txt': 'line one\nline two\n' });
  const d = await openPreview(page, 'short.txt');
  await expect(d.locator('.preview-text')).toContainText('line two');
  const box = await d.boundingBox();
  const innerHeight = await page.evaluate(() => window.innerHeight);
  // The scrim margin is --space-2 (8 px) top and bottom; one more pixel for rounding.
  expect(box!.height).toBeGreaterThanOrEqual(innerHeight - 17);
});
