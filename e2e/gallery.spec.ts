import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { crc32, deflateSync } from 'node:zlib';

// #144: thumbnails in the list and the gallery view with its lightbox (the preview overlay of #142).
// Both projects share one server and data dir; every test works in its own folder named after the project and test.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;

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

const PHOTOS: Record<string, Buffer> = {
  'a-red.png': png(640, 480, [200, 40, 40]),
  'b-green.png': png(480, 640, [40, 160, 60]),
  'c-blue.png': png(600, 600, [40, 60, 200]),
};

/** Creates `/<dir>` with the photos and a sub-folder through the API, then opens it in the SPA in list view. */
async function setup(page: Page, dir: string) {
  // Each test runs in a fresh browser context, so no stored view choice carries over: the folder opens in list view.
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  for (const d of [`/${dir}`, `/${dir}/album`]) {
    expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: d } })).status()).toBe(201);
  }
  for (const [name, body] of Object.entries(PHOTOS)) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: body });
    expect(r.status()).toBe(201);
  }
  await page.goto(`/home/${encodeURIComponent(dir)}`);
  await expect(page.locator('tbody tr')).toHaveCount(4);
}

/** Every image matching `selector` has loaded from the thumbnail route and decoded to real pixels. */
async function expectThumbnailsLoaded(page: Page, selector: string, count: number) {
  const imgs = page.locator(selector);
  await expect(imgs).toHaveCount(count);
  for (const img of await imgs.all()) {
    await img.scrollIntoViewIfNeeded();
    await expect(img).toHaveAttribute('src', /\/api\/v1\/sources\/home\/thumbnail\?path=.*&size=\d+&v=/);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  }
}

test('list rows show thumbnails of images; folders keep their icon', async ({ page }, info) => {
  const dir = `thumbs-${tag(info)}`;
  await setup(page, dir);
  await expectThumbnailsLoaded(page, 'tbody .row-thumb', 3);
  await expect(page.locator('tbody tr[data-type="directory"] .icon-folder')).toHaveCount(1);
});

test('a folder of images in gallery view shows thumbnails; a click opens the lightbox and arrow keys step through it', async ({ page }, info) => {
  const dir = `gallery-${tag(info)}`;
  await setup(page, dir);
  const toggle = page.getByRole('group', { name: /Ansicht|View/ });
  await toggle.getByRole('button', { name: /Galerie|Gallery/ }).click();
  await expect(toggle.getByRole('button', { name: /Galerie|Gallery/ })).toHaveAttribute('aria-pressed', 'true');
  const gallery = page.getByRole('list', { name: /Galerie|Gallery/ });
  await expect(gallery).toBeVisible();
  await expect(page.locator('table.file-list')).toHaveCount(0);
  await expect(gallery.getByRole('listitem')).toHaveCount(4);
  await expectThumbnailsLoaded(page, '.gallery-thumb', 3);
  // Each thumbnail is the photo's own: the tile shows its colour.
  const red = gallery.getByRole('button', { name: 'a-red.png', exact: true }).locator('img');
  const pixel = await red.evaluate((el: HTMLImageElement) => {
    const c = document.createElement('canvas'); c.width = el.naturalWidth; c.height = el.naturalHeight;
    const g = c.getContext('2d')!; g.drawImage(el, 0, 0);
    return [...g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data.slice(0, 3)];
  });
  expect(pixel[0]).toBeGreaterThan(150); expect(pixel[1]).toBeLessThan(90); expect(pixel[2]).toBeLessThan(90);

  // The lightbox: the second photo, then → and ← step through the photos.
  await gallery.getByRole('button', { name: 'b-green.png', exact: true }).click();
  const box = (name: string) => page.getByRole('dialog', { name, exact: true });
  await expect(box('b-green.png')).toBeVisible();
  await expect(box('b-green.png').locator('img.preview-media')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(box('c-blue.png')).toBeVisible();
  await expect(box('c-blue.png').locator('img.preview-media')).toHaveAttribute('src', /c-blue\.png/);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(box('a-red.png')).toBeVisible();
  // Esc closes and the focus is back on the tile of the photo shown last.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(gallery.getByRole('button', { name: 'a-red.png', exact: true })).toBeFocused();

  // A folder tile opens the folder; the view is kept there and after a reload.
  await gallery.getByRole('button', { name: 'album', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/home/${dir}/album$`));
  await expect(page.getByText(/leer|empty/)).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('list', { name: /Galerie|Gallery/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('list', { name: /Galerie|Gallery/ }).getByRole('listitem')).toHaveCount(4);
  await page.getByRole('group', { name: /Ansicht|View/ }).getByRole('button', { name: /Liste|List/ }).click();
  await expect(page.locator('tbody tr')).toHaveCount(4);
});
