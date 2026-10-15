import { expect, test, type Locator, type TestInfo } from '@playwright/test';

// #143: the content route serves a PDF inline with `CSP: sandbox`. The preview must still show it, in Chromium and in
// Firefox (the `desktop-firefox` project runs this file), because pdf.js in the SPA reads the bytes instead of the
// browser's own viewer opening the sandboxed document.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;

/** A two-page PDF with one line of Helvetica text on each page. */
function pdf(lines: [string, string]): Buffer {
  const streams = lines.map((l) => `BT /F1 20 Tf 20 120 Td (${l}) Tj ET`);
  const font = '<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources ${font} /Contents 4 0 R >>`,
    `<< /Length ${streams[0]!.length} >>\nstream\n${streams[0]}\nendstream`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources ${font} /Contents 6 0 R >>`,
    `<< /Length ${streams[1]!.length} >>\nstream\n${streams[1]}\nendstream`];
  let out = '%PDF-1.4\n'; const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** How many dark pixels the canvas has under `text`'s box in the text layer: the glyphs pdf.js painted there. */
const inkUnder = async (d: Locator, text: Locator) => d.locator('canvas').evaluate((c: HTMLCanvasElement, sr) => {
  const cr = c.getBoundingClientRect();
  const k = c.width / cr.width;
  const x = Math.max(0, Math.floor((sr.left - cr.left) * k)); const y = Math.max(0, Math.floor((sr.top - cr.top) * k));
  const w = Math.max(1, Math.min(c.width - x, Math.ceil(sr.width * k))); const h = Math.max(1, Math.min(c.height - y, Math.ceil(sr.height * k)));
  const px = c.getContext('2d')!.getImageData(x, y, w, h).data;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i]! < 100 && px[i + 1]! < 100 && px[i + 2]! < 100) n++;
  return n;
}, await text.evaluate((span) => { const r = span.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; }));

test('a multi-page PDF served with CSP sandbox shows page 1 with its text, and page 2 after Next', async ({ page }, info) => {
  const dir = `pdf-${tag(info)}`;
  const name = 'report.pdf';
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  const path = `/${dir}/${name}`;
  expect((await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=fail`,
    { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: pdf(['First page text', 'Second page text']) })).status()).toBe(201);

  // The bytes pdf.js reads are the sandboxed inline response, not something laxer.
  const raw = await page.request.get(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}`);
  expect(raw.headers()['content-type']).toBe('application/pdf');
  expect(raw.headers()['content-disposition']).toMatch(/^inline;/);
  expect(raw.headers()['content-security-policy']).toBe("sandbox; default-src 'none'");

  const navigations: string[] = [];
  page.on('request', (r) => { if (r.resourceType() === 'document' && r.url().includes('/content?')) navigations.push(r.url()); });
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await page.getByRole('link', { name, exact: true }).click();
  const d = page.getByRole('dialog', { name, exact: true });
  await expect(d).toBeVisible();

  await expect(d.locator('canvas[data-rendered-page="1"]')).toBeVisible();
  const first = d.getByText('First page text', { exact: true });
  await expect(first).toBeVisible();
  expect(await inkUnder(d, first)).toBeGreaterThan(20);
  await expect(d.getByText('Second page text')).toHaveCount(0);
  await expect(d).toContainText(/Seite 1 von 2|Page 1 of 2/);

  await d.getByRole('button', { name: /^(Nächste Seite|Next page)$/ }).click();
  await expect(d.locator('canvas[data-rendered-page="2"]')).toBeVisible();
  const second = d.getByText('Second page text', { exact: true });
  await expect(second).toBeVisible();
  expect(await inkUnder(d, second)).toBeGreaterThan(20);
  await expect(d.getByText('First page text')).toHaveCount(0);

  // The browser never opened the PDF as a document of its own: no frame, no embed, no navigation.
  await expect(d.locator('iframe, embed, object')).toHaveCount(0);
  expect(navigations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
});
