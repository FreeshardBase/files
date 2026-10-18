import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openPlaces } from './places.ts';

// #245: the phone layout. Two buttons in a list row share it at equal width, so "Trennen" does not outweigh "Öffnen"
// (M2); the folder toolbar is one row, "Upload folder" and "New folder" in the Upload button's menu (M3); the settings'
// radios stand one per line (M4); the collision dialog stacks its three buttons, the forward action first (M5). Each
// check runs on desktop (the layout there stays as it was) and phone, in both themes.

const SCHEMES = ['light', 'dark'] as const;
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const mobile = (info: TestInfo) => info.project.name.startsWith('mobile');
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const box = async (l: Locator) => (await l.boundingBox())!;
// The menu button; the file input inside the desktop's "Upload" label is a button of that name too.
const addMenu = (page: Page) => page.getByRole('button', { name: /^(Hochladen|Upload)$/ }).and(page.locator('[aria-haspopup="menu"]'));

async function headers(page: Page) {
  const me = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin };
}
async function mkdir(page: Page, path: string) {
  expect((await page.request.post('/api/v1/sources/home/mkdir', { data: { path }, headers: await headers(page) })).status()).toBe(201);
}
async function putFile(page: Page, path: string, text: string) {
  const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=fail`, {
    data: Buffer.from(text), headers: { ...await headers(page), 'content-type': 'application/octet-stream' } });
  expect(r.status(), await r.text()).toBe(201);
}
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
const style = (l: Locator, prop: string) => l.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

// Every folder of a test lives under its own parent in the home root, removed after the test, so other specs' rows stay in
// the phone's window (the list windows from 200 entries, #225).
let PARENT = '';
test.beforeEach(async ({ page }, info) => {
  await page.goto('/home');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
  PARENT = `/zz-mobile-layout-${info.title.match(/M\d/)![0]}-${tag(info)}`;
  await mkdir(page, PARENT);
});
test.afterEach(async ({ page }) => {
  const r = await page.request.post('/api/v1/sources/home/delete', { data: { paths: [PARENT] }, headers: await headers(page) });
  expect(r.status(), await r.text()).toBe(204);
});

test('the folder toolbar is one row on the phone; "Upload folder" and "New folder" are in the Upload menu (#245 M3)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = `${PARENT}/m3-${scheme}-${tag(info)}`;
    await mkdir(page, dir);
    await putFile(page, `${dir}/note.txt`, 'x');
    await page.goto(`/home${dir}`);
    await expect(row(page, 'note.txt')).toBeVisible();
    const actions = page.locator('.toolbar-actions');
    const newFolder = actions.getByRole('button', { name: /^(Neuer Ordner|New folder)$/ });
    const folderUpload = actions.locator('label.button', { hasText: /^\s*(Ordner hochladen|Upload folder)\s*$/ });
    if (!mobile(info)) {
      // The desktop keeps its separate buttons and has no menu.
      await expect(newFolder).toBeVisible();
      await expect(folderUpload).toBeVisible();
      await expect(addMenu(page)).toBeHidden();
      continue;
    }
    await expect(newFolder).toBeHidden();
    await expect(folderUpload).toBeHidden();
    const menuButton = addMenu(page);
    await expect(menuButton).toBeVisible();
    // Sort menu, view switch and "Upload" share one row inside the page.
    const parts = [actions.locator('.sort-menu'), actions.locator('.view-toggle'), menuButton];
    const boxes = await Promise.all(parts.map(box));
    for (const b of boxes) {
      expect(Math.abs(b.y + b.height / 2 - (boxes[0].y + boxes[0].height / 2))).toBeLessThan(2);
      expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
    // The forward action's amber hairline, as the desktop's "Upload".
    expect(await style(menuButton, 'border-top-color')).toBe(await resolved(page, 'var(--accent)'));

    await menuButton.click();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    const items = page.getByRole('menu').getByRole('menuitem');
    await expect(items).toHaveText([/^(Dateien hochladen|Upload files)$/, /^(Ordner hochladen|Upload folder)$/, /^(Neuer Ordner|New folder)$/]);
    for (const item of await items.all()) await expect(item).toBeInViewport();
    // Esc closes it back onto its button.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(menuButton).toBeFocused();

    // "Upload files" and "Upload folder" open the toolbar's own pickers.
    await menuButton.click();
    const [files] = await Promise.all([page.waitForEvent('filechooser'),
      page.getByRole('menuitem', { name: /^(Dateien hochladen|Upload files)$/ }).click()]);
    expect(await files.element().getAttribute('data-testid')).toBe('upload-input');
    await files.setFiles([]);
    await menuButton.click();
    const [folder] = await Promise.all([page.waitForEvent('filechooser'),
      page.getByRole('menuitem', { name: /^(Ordner hochladen|Upload folder)$/ }).click()]);
    expect(await folder.element().getAttribute('data-testid')).toBe('upload-folder-input');

    // "New folder" opens its dialog.
    await menuButton.click();
    await page.getByRole('menuitem', { name: /^(Neuer Ordner|New folder)$/ }).click();
    const dialog = page.getByRole('dialog', { name: /Neuer Ordner|New folder/ });
    await expect(dialog.getByRole('textbox')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
});

test('two actions in a list row share it at equal width on the phone (#245 M2)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = `${PARENT}/m2-${scheme}-${tag(info)}`;
    const name = `m2-${scheme}-${tag(info)}.txt`;
    await mkdir(page, dir);
    await putFile(page, `${dir}/${name}`, 'x');
    expect((await page.request.post('/api/v1/sources/home/delete',
      { headers: await headers(page), data: { paths: [`${dir}/${name}`] } })).status()).toBe(204);
    await page.goto('/home');
    await openPlaces(page);
    await page.getByRole('navigation', { name: /Orte|Places/ }).getByRole('link', { name: /Papierkorb|Trash/ }).click();
    const r = row(page, name);
    const restore = r.getByRole('button', { name: /wiederherstellen|Restore/ });
    const purge = r.getByRole('button', { name: /endgültig löschen|permanently/ });
    await expect(restore).toBeVisible();
    const [a, b] = [await box(restore), await box(purge)];
    expect(await style(purge, 'border-top-color')).toBe(await resolved(page, 'var(--danger)'));
    if (mobile(info)) {
      expect(Math.abs(a.y - b.y)).toBeLessThan(1); // one row

      expect(Math.abs(a.width - b.width)).toBeLessThan(1);
      const cell = await box(r.locator('td.actions'));
      expect(a.x).toBeCloseTo(cell.x, 0);
      expect(b.x + b.width).toBeCloseTo(cell.x + cell.width, 0);
    } else {
      // Above 1200 px the trash's two actions stand one over the other at equal width (#309).
      expect(b.y).toBeGreaterThan(a.y + a.height);
      expect(Math.abs(a.width - b.width)).toBeLessThan(1);
      expect(Math.abs(a.x - b.x)).toBeLessThan(1);
    }
  }
});

test('the language and theme radios stand one per line on the phone (#245 M4)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/settings');
    for (const group of [/^(Sprache|Language)$/, /^(Darstellung|Design|Theme)$/]) {
      const radios = page.getByRole('group', { name: group }).locator('.settings-radio');
      await expect(radios.first()).toBeVisible();
      const boxes = await Promise.all((await radios.all()).map(box));
      expect(boxes.length).toBeGreaterThanOrEqual(3);
      if (mobile(info)) {
        for (let i = 1; i < boxes.length; i++) {
          expect(boxes[i].x).toBeCloseTo(boxes[0].x, 0);
          expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].height - 1);
        }
      } else {
        expect(boxes[1].y).toBeCloseTo(boxes[0].y, 0); // the desktop keeps one row
      }
    }
  }
});

test('the collision dialog stacks its three buttons full width on the phone, the forward action first (#245 M5)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = `${PARENT}/m5-${scheme}-${tag(info)}`;
    await mkdir(page, dir);
    await putFile(page, `${dir}/same.txt`, 'old');
    await page.goto(`/home${dir}`);
    await expect(row(page, 'same.txt')).toBeVisible();
    await page.getByTestId('upload-input').setInputFiles([{ name: 'same.txt', mimeType: 'text/plain', buffer: Buffer.from('new') }]);
    const dialog = page.getByRole('dialog', { name: /schon vergeben|bereits vergeben|already taken/ });
    await expect(dialog).toBeVisible();
    const keep = await box(dialog.getByRole('button', { name: /Beide behalten|Keep both/ }));
    const replace = await box(dialog.getByRole('button', { name: /Ersetzen|Replace/ }));
    const skip = await box(dialog.getByRole('button', { name: /Überspringen|Skip/ }));
    if (mobile(info)) {
      const actions = await box(dialog.locator('.app-dialog-actions'));
      for (const b of [keep, replace, skip]) {
        expect(b.x).toBeCloseTo(actions.x, 0);
        expect(b.width).toBeCloseTo(actions.width, 0);
      }
      expect(replace.y).toBeGreaterThan(keep.y + keep.height - 1);
      expect(skip.y).toBeGreaterThan(replace.y + replace.height - 1);
    } else {
      // The desktop keeps one row, the forward action last on the right (#238).
      expect(replace.y).toBeCloseTo(keep.y, 0);
      expect(skip.y).toBeCloseTo(keep.y, 0);
      expect(keep.x).toBeGreaterThan(replace.x);
      expect(replace.x).toBeGreaterThan(skip.x);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
});
