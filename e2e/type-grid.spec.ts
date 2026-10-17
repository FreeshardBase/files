import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

// #239: the type scale and the page grid of the design guide. Titles are h2, section headings h3 (T3 H1); the folder's
// current crumb is its title (H2); mono is for numbers, never for state words (H3); an uppercase label sits above every
// field, hints under it (H4); field errors are small and sit under the field (H5). Every view shares one page column,
// left-aligned beside the sidebar, and the header's search starts on its edge (G1, G2); the upload panel sits under the
// toolbar (G3); the selection bar replaces the toolbar's actions and counts the selection (G4); the list's sheet has
// round corners (G5). Each check runs on desktop and phone (the two projects) and in both themes.

const SCHEMES = ['light', 'dark'] as const;
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const mobile = (info: TestInfo) => info.project.name.startsWith('mobile');
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const menuButton = (page: Page, name: string) => row(page, name).getByRole('button', { name: /^(Actions for|Aktionen für) / });
const MONO = /IBM Plex Mono/;

async function headers(page: Page) {
  const me = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin };
}
async function mkdir(page: Page, path: string) {
  const r = await page.request.post('/api/v1/sources/home/mkdir', { data: { path }, headers: await headers(page) });
  expect([201, 409]).toContain(r.status());
}
async function putFile(page: Page, path: string, text: string) {
  const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=replace`, {
    data: Buffer.from(text), headers: { ...await headers(page), 'content-type': 'application/octet-stream' } });
  expect(r.status(), await r.text()).toBeLessThan(300);
}
async function folderWith(page: Page, info: TestInfo, prefix: string, files: string[]): Promise<string> {
  const dir = `/${prefix}-${tag(info)}`;
  await mkdir(page, dir);
  for (const f of files) await putFile(page, `${dir}/${f}`, `${f}\n`);
  return dir;
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
const style = (l: Locator, prop: string) => l.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
/** The computed style an element of `tag.cls` gets inside the main area, for headings a view shows only with data. */
const probeStyle = (page: Page, tagName: string, cls: string, prop: string) => page.evaluate(([t, c, p]) => {
  const el = document.createElement(t!);
  el.className = c!;
  el.textContent = 'x';
  document.querySelector('main')!.append(el);
  const out = getComputedStyle(el).getPropertyValue(p!);
  el.remove();
  return out;
}, [tagName, cls, prop]);
const box = async (l: Locator) => (await l.boundingBox())!;

test.beforeEach(async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('every view title is an h2 of the scale; section headings are h3, the share heading stays small (#239 H1)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of ['/trash', '/recent', '/favourites', '/shared', '/connections', '/storage', '/members', '/settings', '/migrate']) {
      await page.goto(path);
      const title = page.locator('.view-title').first();
      await expect(title).toBeVisible();
      expect(await style(title, 'font-size'), path).toBe('20px');
      expect(await style(title, 'font-weight'), path).toBe('600');
    }
    await page.goto('/settings');
    const heading = page.locator('.settings-heading').first();
    await expect(heading).toBeVisible();
    expect(await style(heading, 'font-size')).toBe('16px');
    expect(await style(heading, 'font-weight')).toBe('600');
    await page.goto('/storage');
    await expect(page.locator('.storage-heading').first()).toBeVisible();
    expect(await style(page.locator('.storage-heading').first(), 'font-size')).toBe('16px');
    for (const cls of ['migrate-step', 'connections-add']) expect(await probeStyle(page, 'h2', cls, 'font-size'), cls).toBe('16px');

    // The details drawer's small headings ("Who has access") stay small and bold under the h3 title.
    const dir = await folderWith(page, info, `h1-${scheme}`, ['ledger.csv']);
    await page.goto(`/home${dir}`);
    await menuButton(page, 'ledger.csv').click();
    await page.getByRole('menuitem', { name: /^Details$/ }).click();
    const drawerHeading = page.getByRole('dialog').locator('.fs-section-heading').first();
    await expect(drawerHeading).toBeVisible();
    expect(await style(drawerHeading, 'font-size')).toBe('13px');
    expect(await style(drawerHeading, 'font-weight')).toBe('600');
    await page.keyboard.press('Escape');
  }
});

test('the folder\'s current crumb is its title: h2, bold, in ink; the ancestors are small and teal (#239 H2)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = await folderWith(page, info, `h2-${scheme}`, []);
    await mkdir(page, `${dir}/Projekte`);
    await page.goto(`/home${dir}/Projekte`);
    const crumbs = page.getByRole('navigation', { name: /Pfad|Path/ });
    const current = crumbs.locator('a[aria-current="page"]');
    await expect(current).toHaveText('Projekte');
    expect(await style(current, 'font-size')).toBe('20px');
    expect(await style(current, 'font-weight')).toBe('600');
    expect(await style(current, 'color')).toBe(await resolved(page, 'var(--ink)'));
    const ancestor = crumbs.getByRole('link', { name: dir.slice(1), exact: true });
    expect(await style(ancestor, 'font-size')).toBe('13px');
    expect(await style(ancestor, 'color')).toBe(await resolved(page, 'var(--line)'));
    // The title is visibly the largest text on the line.
    expect((await box(current)).height).toBeGreaterThan((await box(ancestor)).height - 0.5);
  }
});

test('state words use the UI face, sizes and dates the mono face (#239 H3)', async ({ page, browser, baseURL }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = await folderWith(page, info, `h3-${scheme}`, ['ledger.csv']);
    await putFile(page, `${dir}/ledger.csv`, 'a newer ledger\n'); // a replace keeps a version (#154)
    await page.goto(`/home${dir}`);
    await expect(row(page, 'ledger.csv')).toBeVisible();

    // Upload states: "Uploaded" and "Failed: …" are words.
    await page.getByTestId('upload-input').setInputFiles({ name: 'done.txt', mimeType: 'text/plain', buffer: Buffer.from('ok') });
    const panel = page.getByTestId('upload-panel');
    const doneState = panel.locator('.upload-item', { hasText: 'done.txt' }).locator('.upload-state');
    await expect(doneState).toHaveText(/Hochgeladen|Uploaded/);
    expect(await style(doneState, 'font-family')).not.toMatch(MONO);
    await page.route('**/api/v1/uploads**', (route) => route.abort('internetdisconnected'));
    await page.getByTestId('upload-input').setInputFiles({ name: 'fails.txt', mimeType: 'text/plain', buffer: Buffer.from('no') });
    const failedState = panel.locator('.upload-item', { hasText: 'fails.txt' }).locator('.upload-state');
    await expect(failedState).toHaveText(/Fehlgeschlagen|Failed/);
    expect(await style(failedState, 'font-family')).not.toMatch(MONO);
    await page.unroute('**/api/v1/uploads**');
    await panel.getByRole('button', { name: /^(Erledigte entfernen|Clear finished)$/ }).click();

    // The details drawer: size and modified date in mono, and so are the versions' date and size.
    await menuButton(page, 'ledger.csv').click();
    await page.getByRole('menuitem', { name: /^Details$/ }).click();
    const drawer = page.getByRole('dialog');
    const facts = drawer.locator('.details-facts dd');
    await expect(facts.nth(1)).toBeVisible();
    expect(await style(facts.nth(0), 'font-family'), 'type').not.toMatch(MONO);
    expect(await style(facts.nth(1), 'font-family'), 'size').toMatch(MONO);
    expect(await style(facts.nth(2), 'font-family'), 'modified').toMatch(MONO);
    const version = drawer.getByRole('list', { name: /^(Versionen|Versions)$/ }).getByRole('listitem').first();
    await expect(version).toBeVisible();
    expect(await style(version.locator('.share-name'), 'font-family'), 'version date').toMatch(MONO);
    expect(await style(version.locator('.share-level').first(), 'font-family'), 'version size').toMatch(MONO);
    await page.keyboard.press('Escape');

    // Members: "No quota" is a word in the quota column.
    await page.goto('/members');
    const noQuota = page.locator('td.members-quota').getByText(/^(Kein Speicherlimit|No storage limit)$/).first();
    await expect(noQuota).toBeVisible();
    expect(await style(noQuota, 'font-family')).not.toMatch(MONO);

    // The visitor's page: the size in mono.
    const r = await page.request.post('/api/v1/links', { headers: await headers(page), data: { source: 'home', path: `${dir}/ledger.csv` } });
    expect(r.status()).toBe(201);
    const { token } = await r.json() as { token: string };
    const ctx = await browser.newContext({ baseURL, colorScheme: scheme, ...(mobile(info) ? { viewport: { width: 412, height: 839 } } : {}) });
    const v = await ctx.newPage();
    await v.goto(`/s/${token}`);
    const size = v.locator('.details-facts dd').first();
    await expect(size).toBeVisible();
    expect(await style(size, 'font-family')).toMatch(MONO);
    await ctx.close();
  }
});

test('every field has an uppercase label above it; a hint sits under the field, never in the placeholder (#239 H4)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/settings');
    for (const name of [/^(Adresse|Address)$/, /^(Gerät oder Programm|Device or program)$/]) {
      const field = page.getByLabel(name);
      await expect(field).toBeVisible();
      const label = page.locator(`label[for="${await field.getAttribute('id')}"]`);
      expect(await style(label, 'text-transform')).toBe('uppercase');
      expect(await style(label, 'font-size')).toBe('10px');
      expect((await box(label)).y + (await box(label)).height).toBeLessThanOrEqual((await box(field)).y + 0.5);
    }
    // The password shown once: its label is the same uppercase label.
    await page.getByLabel(/^(Gerät oder Programm|Device or program)$/).fill(`label-${scheme}-${tag(info)}`);
    await page.getByRole('button', { name: /App-Passwort erstellen|Create app password/ }).click();
    const shown = page.getByRole('dialog');
    const password = shown.getByRole('textbox');
    await expect(password).toBeVisible();
    const pwLabel = shown.locator(`label[for="${await password.getAttribute('id')}"]`);
    expect(await style(pwLabel, 'text-transform')).toBe('uppercase');
    await shown.getByRole('button', { name: /^(Fertig|Done)$/ }).click();

    // The public link form: the label's hint is under the field and describes it; there is no placeholder.
    const dir = await folderWith(page, info, `h4-${scheme}`, ['ledger.csv']);
    await page.goto(`/home${dir}`);
    await menuButton(page, 'ledger.csv').click();
    await page.getByRole('menuitem', { name: /^(Teilen|Share)/ }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('button', { name: /Neuer öffentlicher Link|New public link/ }).click();
    const form = d.getByRole('form', { name: /Neuer öffentlicher Link|New public link/ });
    const labelField = form.getByLabel(/^(Bezeichnung|Label)$/);
    await expect(labelField).toBeVisible();
    expect(await labelField.getAttribute('placeholder')).toBeNull();
    const hint = form.getByText(/^(Nur für dich sichtbar|Nur für Sie sichtbar|Only you see it)/);
    await expect(hint).toBeVisible();
    await expect(labelField).toHaveAccessibleDescription(/(Nur für dich sichtbar|Nur für Sie sichtbar|Only you see it)/);
    expect((await box(hint)).y).toBeGreaterThanOrEqual((await box(labelField)).y + (await box(labelField)).height - 0.5);
    expect(await style(hint, 'font-size')).toBe('13px');
    expect(await style(hint, 'color')).toBe(await resolved(page, 'var(--ink-muted)'));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
});

test('a field error is small text right under its field (#239 H5)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = await folderWith(page, info, `h5-${scheme}`, ['ledger.csv']);
    await page.goto(`/home${dir}`);
    await menuButton(page, 'ledger.csv').click();
    await page.getByRole('menuitem', { name: /^(Umbenennen|Rename)/ }).click();
    const d = page.getByRole('dialog');
    const input = d.getByRole('textbox');
    await input.fill('a/b');
    await d.getByRole('button', { name: /^(Umbenennen|Rename)$/ }).click();
    const error = d.locator('.fs-field__error');
    await expect(error).toBeVisible();
    expect(await style(error, 'font-size')).toBe('13px');
    expect(await style(error, 'margin-top')).toBe('4px');
    expect(await style(error, 'margin-bottom')).toBe('16px');
    const gap = (await box(error)).y - ((await box(input)).y + (await box(input)).height);
    expect(gap).toBeGreaterThanOrEqual(2);
    expect(gap).toBeLessThanOrEqual(6);
    await page.keyboard.press('Escape');
  }
});

test('every view shares one page column beside the sidebar; the header\'s search starts on its edge (#239 G1, G2)', async ({ page }, info) => {
  if (!mobile(info)) await page.setViewportSize({ width: 1440, height: 900 });
  const dir = await folderWith(page, info, 'g1', ['ledger.csv']);
  const views: [string, number][] = [[`/home${dir}`, 960], ['/trash', 960], ['/recent', 960], ['/favourites', 960],
    ['/shared', 960], ['/connections', 960], ['/storage', 960], ['/members', 960], ['/settings', 720], ['/migrate', 720]];
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const edges: number[] = [];
    for (const [path, max] of views) {
      await page.goto(path);
      const pageBox = page.locator('main > section.page');
      await expect(pageBox).toHaveCount(1);
      await expect(page.locator('.view-title, .breadcrumbs').first()).toBeVisible();
      const b = await box(pageBox);
      const main = await box(page.locator('main'));
      const pad = parseFloat(await style(page.locator('main'), 'padding-left'));
      // Left-aligned beside the sidebar, never centred in the leftover width.
      expect(Math.abs(b.x - (main.x + pad)), path).toBeLessThan(1);
      expect(b.width, path).toBeLessThanOrEqual(max + 0.5);
      if (main.width - 2 * pad >= max) expect(b.width, path).toBeGreaterThan(max - 0.5);
      else expect(Math.abs(b.width - (main.width - 2 * pad)), path).toBeLessThan(1);
      edges.push(b.x);
      // The search field in the header starts on the column's edge.
      expect(Math.abs((await box(page.locator('.search'))).x - b.x), `search on ${path}`).toBeLessThan(1);
    }
    expect(new Set(edges.map(Math.round)).size).toBe(1);
  }
});

test('the upload panel sits under the toolbar, inside the column; the title stays put when an upload starts (#239 G3)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = await folderWith(page, info, `g3-${scheme}`, ['ledger.csv']);
    await page.goto(`/home${dir}`);
    const title = page.locator('.breadcrumbs a[aria-current="page"]');
    await expect(row(page, 'ledger.csv')).toBeVisible();
    const before = await box(title);
    await page.getByTestId('upload-input').setInputFiles({ name: 'new.txt', mimeType: 'text/plain', buffer: Buffer.from('new') });
    const panel = page.getByTestId('upload-panel');
    await expect(panel).toContainText(/Hochgeladen|Uploaded/);
    const after = await box(title);
    expect(Math.abs(after.y - before.y)).toBeLessThan(0.5);
    expect(await style(panel, 'box-sizing')).toBe('border-box');
    const p = await box(panel);
    const column = await box(page.locator('section.folder'));
    expect(p.x).toBeGreaterThanOrEqual(column.x - 0.5);
    expect(p.x + p.width).toBeLessThanOrEqual(column.x + column.width + 0.5);
    expect(p.y).toBeGreaterThanOrEqual((await box(page.locator('.toolbar'))).y + (await box(page.locator('.toolbar'))).height - 0.5);
    await panel.getByRole('button', { name: /^(Erledigte entfernen|Clear finished)$/ }).click();
    await expect(panel).toHaveCount(0);
  }
});

test('the selection bar counts the selection, takes the toolbar\'s place and never moves the list (#239 G4)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = await folderWith(page, info, `g4-${scheme}`, ['a.txt', 'b.txt', 'c.txt']);
    await page.goto(`/home${dir}`);
    await expect(row(page, 'c.txt')).toBeVisible();
    const list = page.locator('table.file-list');
    const before = await box(list);
    await row(page, 'a.txt').getByRole('checkbox').check();
    await row(page, 'b.txt').getByRole('checkbox').check();
    const bar = page.getByRole('group', { name: /^(Aktionen für die Auswahl|Actions for the selection)$/ });
    await expect(bar).toBeVisible();
    await expect(bar.locator(':scope > *').first()).toHaveText(/^(2 ausgewählt|2 selected)$/);
    expect(Math.abs((await box(list)).y - before.y)).toBeLessThan(0.5);
    if (!mobile(info)) {
      // In place of the toolbar's actions, at the right end of the toolbar.
      await expect(page.locator('.toolbar-actions')).toBeHidden();
      const toolbar = await box(page.locator('.toolbar'));
      const b = await box(bar);
      expect(Math.abs(b.x + b.width - (toolbar.x + toolbar.width))).toBeLessThan(1);
      expect(b.y).toBeGreaterThanOrEqual(toolbar.y - 0.5);
      expect(b.y + b.height).toBeLessThanOrEqual(toolbar.y + toolbar.height + 0.5);
    }
    await row(page, 'a.txt').getByRole('checkbox').uncheck();
    await expect(bar.locator(':scope > *').first()).toHaveText(/^(1 ausgewählt|1 selected)$/);
    await row(page, 'b.txt').getByRole('checkbox').uncheck();
    await expect(bar).toHaveCount(0);
    await expect(page.locator('.toolbar-actions')).toBeVisible();
    expect(Math.abs((await box(list)).y - before.y)).toBeLessThan(0.5);
  }
});

test('the list is a sheet with the guide\'s round corners (#239 G5)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = await folderWith(page, info, `g5-${scheme}`, ['ledger.csv']);
    await page.goto(`/home${dir}`);
    const list = page.locator('table.file-list');
    await expect(row(page, 'ledger.csv')).toBeVisible();
    expect(await style(list, 'border-collapse')).toBe('separate');
    expect(await style(list, 'border-top-left-radius')).toBe('14px');
    expect(await style(list, 'border-bottom-right-radius')).toBe('14px');
    // The painted corner: the pixel just inside the square corner is the page's ground, not the sheet's border.
    const shot = await list.screenshot({ animations: 'disabled' });
    const bg = await resolved(page, 'var(--bg)');
    const corner = await page.evaluate(async ([png, ground]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const [r, g, b] = ctx.getImageData(1, 1, 1, 1).data;
      const want = ground!.match(/\d+/g)!.map(Number);
      return Math.max(Math.abs(r! - want[0]!), Math.abs(g! - want[1]!), Math.abs(b! - want[2]!));
    }, [shot.toString('base64'), bg]);
    expect(corner).toBeLessThan(8);
  }
});
