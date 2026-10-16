import { expect, test, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// #160: the polish pass. Accessibility (axe, names, focus), mobile (no horizontal scroll, 44 px targets, the item menu,
// the collapsible sidebar), menus that only offer valid actions, empty states per view, no dead controls, keyboard help,
// history navigation and screenshot baselines. Both projects share one server and one `testuser`; every test works in
// its own folder and sets the language and theme it expects.

type Settings = { locale: 'de-du' | 'de-sie' | 'en' | null; theme: 'light' | 'dark' | 'system' };
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const mobile = (info: TestInfo) => info.project.name.startsWith('mobile');
const places = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const crumbs = (page: Page) => page.getByRole('navigation', { name: /Pfad|Path/ });
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const menuButton = (page: Page, name: string) => row(page, name).getByRole('button', { name: `Actions for ${name}` });

async function headers(page: Page) {
  const me = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin };
}
async function putSettings(page: Page, s: Settings) {
  const r = await page.request.put('/api/v1/settings', { data: s, headers: await headers(page) });
  expect(r.status(), await r.text()).toBe(200);
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
async function trashFile(page: Page, path: string) {
  await putFile(page, path, 'to be trashed');
  const r = await page.request.post('/api/v1/sources/home/delete', { data: { paths: [path] }, headers: await headers(page) });
  expect(r.status(), await r.text()).toBeLessThan(300);
}

/** A second browser context signed in as `login`, with the project's device. */
async function signedIn(browser: Browser, info: TestInfo, baseURL: string, login: string, returnTo = '/'): Promise<Page> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const ctx = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
  const p = await ctx.newPage();
  await p.goto(`/auth/login?login_hint=${login}&returnTo=${encodeURIComponent(returnTo)}`);
  await expect(places(p)).toBeVisible();
  return p;
}

/** A folder with a subfolder and two files, the shape every main-screen check uses. */
async function sampleFolder(page: Page, info: TestInfo, prefix: string): Promise<string> {
  const dir = `/${prefix}-${tag(info)}`;
  await mkdir(page, dir);
  await mkdir(page, `${dir}/Inner`);
  await putFile(page, `${dir}/notes.txt`, 'some notes\n');
  await putFile(page, `${dir}/plan.md`, '# Plan\n');
  return dir;
}

// Each main screen: its address and what shows once it has loaded.
type Screen = { name: string; url: string; ready: (p: Page) => Locator };
const screens = (dir: string): Screen[] => [
  { name: 'folder', url: `/home${dir}`, ready: (p) => row(p, 'notes.txt') },
  { name: 'trash', url: '/trash', ready: (p) => p.getByRole('heading', { name: 'Trash' }) },
  { name: 'recent', url: '/recent', ready: (p) => p.getByRole('heading', { name: 'Recent' }) },
  { name: 'favourites', url: '/favourites', ready: (p) => p.getByRole('heading', { name: 'Favourites' }) },
  { name: 'shared', url: '/shared', ready: (p) => p.getByRole('heading', { name: 'Shared with me' }) },
  { name: 'settings', url: '/settings', ready: (p) => p.getByRole('heading', { name: 'Settings', level: 1 }) },
  { name: 'storage', url: '/storage', ready: (p) => p.getByRole('heading', { name: 'Storage usage', level: 1 }) },
  { name: 'admin', url: '/members', ready: (p) => p.getByRole('heading', { name: 'Members', level: 1 }) },
];
async function open(page: Page, s: Screen) {
  await page.goto(s.url);
  await expect(s.ready(page)).toBeVisible();
  await expect(page.getByText('Loading …')).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/home');
  await expect(places(page)).toBeAttached();
  await putSettings(page, { locale: 'en', theme: 'light' });
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await putSettings(page, { locale: null, theme: 'system' });
  // The dead-UI check clicks the sortable column headers (#226); the next test starts from the default sort.
  const r = await page.request.put('/api/v1/settings/sort', { data: { key: 'name', dir: 'asc' }, headers: await headers(page) });
  expect(r.status(), await r.text()).toBe(200);
});

async function axe(page: Page, what: string) {
  const r = await new AxeBuilder({ page }).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${what}: ${v.id} at ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(bad).toEqual([]);
}

test('axe finds no serious or critical violation on the main screens and dialogs, in both themes (#125)', async ({ page }, info) => {
  const dir = await sampleFolder(page, info, 'axe');
  await trashFile(page, `${dir}/old.txt`);
  for (const theme of ['light', 'dark'] as const) {
    await putSettings(page, { locale: 'en', theme });
    for (const s of screens(dir)) {
      await open(page, s);
      await axe(page, `${theme} ${s.name}`);
    }
    // The dialogs on the folder: preview, share, details, keyboard help.
    await open(page, screens(dir)[0]!);
    await row(page, 'notes.txt').getByRole('link', { name: 'notes.txt' }).click();
    await expect(page.getByRole('dialog', { name: 'notes.txt' })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('some notes')).toBeVisible();
    await axe(page, `${theme} preview`);
    await page.keyboard.press('Escape');
    for (const action of ['Share', 'Details'] as const) {
      await menuButton(page, 'notes.txt').click();
      await page.getByRole('menu').getByRole('menuitem', { name: action }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await axe(page, `${theme} ${action}`);
      // The share dialog's member list opens on focus once the shard has members (#223); Esc closes it first.
      if (await page.getByRole('listbox').isVisible()) await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await axe(page, `${theme} shortcuts`);
    await page.keyboard.press('Escape');
  }
});

test('every icon-only control has an accessible name, and Tab shows a visible focus on every stop (#125)', async ({ page }, info) => {
  test.skip(mobile(info), 'Tab is the keyboard path; the phone has the touch checks');
  const dir = await sampleFolder(page, info, 'focus');
  await trashFile(page, `${dir}/old.txt`);
  for (const s of screens(dir)) {
    await open(page, s);
    const unnamed = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button, [role="button"], a[href], [role="menuitem"]')]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => {
        const by = el.getAttribute('aria-labelledby');
        const name = el.getAttribute('aria-label') ?? (by ? document.getElementById(by)?.textContent : null) ?? el.textContent ?? el.title;
        return !name?.trim();
      }).map((el) => el.outerHTML.slice(0, 120)));
    expect(unnamed, s.name).toEqual([]);

    // Walk the page by Tab and look at each stop's ring: a teal outline, or a field's own ring (box-shadow).
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    const seen = new Set<string>();
    const unringed: string[] = [];
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const ringed = (x: Element | null) => {
          if (!x) return false;
          const st = getComputedStyle(x);
          return (st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) >= 1) || st.boxShadow !== 'none';
        };
        // A visually hidden input shows its ring on the label it sits in (`.button:has(:focus-visible)`).
        const ok = ringed(el) || (el.classList.contains('visually-hidden') && ringed(el.parentElement));
        return { key: `${el.tagName} ${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40)}`, id: el.outerHTML.slice(0, 160), ok };
      });
      if (!stop) continue;
      if (seen.has(stop.id)) break; // came round
      seen.add(stop.id);
      if (!stop.ok) unringed.push(stop.key);
    }
    expect(seen.size, s.name).toBeGreaterThan(3);
    expect(unringed, s.name).toEqual([]);
  }
});

test('phone: no horizontal scroll, touch targets of at least 44 px, every action in the item menu, long-press opens it', async ({ page }, info) => {
  test.skip(!mobile(info), 'phone layout');
  const dir = await sampleFolder(page, info, 'touch');
  await trashFile(page, `${dir}/old.txt`);
  for (const s of screens(dir)) {
    await open(page, s);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${s.name} scrolls sideways`).toBeLessThanOrEqual(0);
    const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(
      'button, [role="button"], a[href], input, select, textarea')]
      .filter((el) => el.getClientRects().length > 0 && !el.closest('p')) // a link inside a sentence is inline text
      .map((el) => (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio' || el.classList.contains('visually-hidden'))
        ? el.closest('label') ?? el : el))
      .filter((el) => { const b = el.getBoundingClientRect(); return b.width < 44 || b.height < 44; })
      .map((el) => { const b = el.getBoundingClientRect(); return `${el.tagName}.${el.className} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(b.width)}x${Math.round(b.height)}`; }));
    expect(small, s.name).toEqual([]);
  }

  // The menu has every action the selection bar and the keyboard offer.
  await open(page, screens(dir)[0]!);
  await menuButton(page, 'notes.txt').click();
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['Download', 'Share', 'Details', 'Rename',
    'Move', 'Copy', 'Add to favourites', 'Move to trash']);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  // Long-press on a row opens the same menu (a touch held still for half a second).
  const box = (await row(page, 'plan.md').locator('td.size').boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(800);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(row(page, 'plan.md').getByRole('menu')).toBeVisible();
  await expect(row(page, 'plan.md').getByRole('menuitem', { name: 'Rename' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0); // the touch did not also open the preview
});

test('phone: the sidebar is collapsed behind "Places" and closes again after choosing a place', async ({ page }, info) => {
  test.skip(!mobile(info), 'phone layout');
  await page.goto('/home');
  const toggle = places(page).getByRole('button', { name: 'Places' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(places(page).getByRole('link', { name: 'Trash' })).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await places(page).getByRole('link', { name: 'Trash' }).click();
  await expect(page).toHaveURL(/\/trash$/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(places(page).getByRole('link', { name: 'Recent' })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
});

test('desktop: the sidebar is always open and has no toggle', async ({ page }, info) => {
  test.skip(mobile(info), 'desktop layout');
  await page.goto('/home');
  await expect(places(page).getByRole('link', { name: 'Trash' })).toBeVisible();
  await expect(places(page).getByRole('button', { name: 'Places' })).toBeHidden();
});

test('in the trash and in a read-only share, no menu offers rename, move or upload (#116)', async ({ page, browser, baseURL }, info) => {
  const dir = await sampleFolder(page, info, 'readonly');
  await trashFile(page, `${dir}/gone.txt`);
  // Trash: a right-click opens no app menu, and the row's only actions are restore and delete.
  await page.goto('/trash');
  const trashed = page.locator('tbody tr', { hasText: 'gone.txt' }).first();
  await trashed.click({ button: 'right' });
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trashed.getByRole('button')).toHaveText(['Restore', 'Delete permanently']);
  await expect(page.getByRole('button', { name: /Upload|Rename|Move|Cut/ })).toHaveCount(0);

  // A read share as the member.
  const member = await signedIn(browser, info, baseURL!, 'member', '/shared');
  const members = await (await page.request.get('/api/v1/members')).json() as { items: { id: string; displayName: string }[] };
  const grantee = members.items.find((m) => m.displayName === 'Test Member')!.id;
  const r = await page.request.post('/api/v1/shares', { data: { source: 'home', path: dir, grantee, access: 'read' }, headers: await headers(page) });
  expect(r.status(), await r.text()).toBeLessThan(300);
  const incoming = await (await member.request.get('/api/v1/shares/incoming')).json() as { items: { name: string; source: string }[] };
  const source = incoming.items.find((s) => s.name === dir.slice(1))!.source;
  await member.goto(`/${source}`);
  await expect(row(member, 'notes.txt')).toBeVisible();
  // The member has no language of their own: English, like the project's browser.
  for (const name of ['notes.txt', 'Inner']) {
    const items = member.getByRole('menu').getByRole('menuitem');
    await row(member, name).locator('td.name').click({ button: 'right' });
    await expect(items).toHaveText(['Download', 'Details', 'Add to favourites']);
    await member.keyboard.press('Escape');
    await expect(items).toHaveCount(0);
    await menuButton(member, name).click();
    await expect(items).toHaveText(['Download', 'Details', 'Add to favourites']);
    await member.keyboard.press('Escape');
  }
  // F2 and Delete do nothing there, and there is no upload anywhere.
  await row(member, 'notes.txt').focus();
  await member.keyboard.press('F2');
  await member.keyboard.press('Delete');
  await expect(member.getByRole('dialog')).toHaveCount(0);
  await expect(row(member, 'notes.txt')).toBeVisible();
  await expect(member.getByRole('button', { name: /Hochladen|Upload/ })).toHaveCount(0);
  await expect(member.locator('input[type=file]')).toHaveCount(0);
  await row(member, 'notes.txt').locator('input[type=checkbox]').check();
  const bar = member.getByRole('group', { name: 'Actions for the selection' });
  await expect(bar.getByRole('link', { name: 'Download' })).toBeVisible();
  await expect(bar.getByRole('button')).toHaveCount(0);
  await member.context().close();
});

test('each view has its own empty-state text (#127)', async ({ page }, info) => {
  const empty = (url: string, body: unknown) => page.route(url, (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }) : route.fallback());
  await empty('**/api/v1/recent', { items: [] });
  await empty('**/api/v1/favourites', { items: [] });
  await empty('**/api/v1/trash', { items: [], totalSize: 0, retentionDays: 30 });
  await empty('**/api/v1/shares/incoming', { items: [] });
  const dir = `/empty-${tag(info)}`;
  await mkdir(page, dir);
  const texts = new Map<string, string>();
  const expectations: [string, string, RegExp][] = [
    ['folder', `/home${dir}`, /^This folder is empty\.$/],
    ['recent', '/recent', /^Nothing here yet\. Files you upload/],
    ['favourites', '/favourites', /^No favourites yet\./],
    ['trash', '/trash', /^The trash is empty\.$/],
    ['shared', '/shared', /^Nothing has been shared with you yet\.$/],
  ];
  for (const [view, url, text] of expectations) {
    await page.goto(url);
    const note = page.locator('main').getByText(text);
    await expect(note, view).toBeVisible();
    await expect(page.locator('main table'), view).toHaveCount(0);
    texts.set(view, (await note.textContent())!.trim());
  }
  // Search: its own sentence with the query, never a view's.
  await page.goto('/home');
  await page.getByRole('combobox', { name: /Search/ }).fill('zz-nothing-matches-this');
  await expect(page.getByText('Nothing found with “zz-nothing-matches-this” in its name.')).toBeVisible();
  texts.set('search', 'Nothing found');
  expect(new Set(texts.values()).size).toBe(texts.size);
});

test('no dead controls: every button on the main screens does something visible when clicked (#124)', async ({ page }, info) => {
  test.setTimeout(300_000);
  // Every screen opens in the list view, whatever an earlier click on "Gallery" stored on this device.
  await page.addInitScript(() => localStorage.setItem('files.view', 'list'));
  const dir = await sampleFolder(page, info, 'dead');
  await trashFile(page, `${dir}/old.txt`);
  const buttons = (p: Page) => p.locator('button:visible, [role="button"]:visible');
  const clicked: string[] = [];
  for (const s of screens(dir)) {
    await open(page, s);
    const count = await buttons(page).count();
    expect(count, s.name).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await open(page, s);
      const b = buttons(page).nth(i);
      if (await b.count() === 0) break; // an earlier click took items away (a restore)
      if (!await b.isEnabled()) continue;
      // The current choice of a segmented toggle (list/gallery) is already in effect.
      if (await b.evaluate((el) => el.getAttribute('aria-pressed') === 'true' && el.closest('[role="group"]') !== null)) continue;
      const label = `${s.name}: ${(await b.getAttribute('aria-label')) ?? (await b.textContent())?.trim()}`;
      await page.evaluate(() => {
        const w = window as unknown as { changes: number; before: string };
        w.changes = 0; w.before = location.href;
        new MutationObserver((m) => { w.changes += m.length; })
          .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      });
      let downloaded = false;
      page.once('download', () => { downloaded = true; });
      await b.click();
      await expect.poll(async () => downloaded || await page.evaluate(() => {
        const w = window as unknown as { changes?: number; before?: string };
        return w.changes === undefined || (w.changes ?? 0) > 0 || w.before !== location.href;
      }), { message: `${label} has no visible effect`, timeout: 3000 }).toBe(true);
      clicked.push(label);
    }
  }
  // The screens were not empty: the folder's rows, the trash row and the header were all clicked.
  expect(clicked.some((c) => c.startsWith('folder: Actions for notes.txt'))).toBe(true);
  expect(clicked.some((c) => c.startsWith('trash: Restore'))).toBe(true);
  expect(clicked.some((c) => c.endsWith('Keyboard shortcuts'))).toBe(true);
});

test('the header shows the member\'s display name from OIDC', async ({ page, browser, baseURL }, info) => {
  await page.goto('/home');
  await expect(page.getByRole('banner')).toContainText('Test User');
  const member = await signedIn(browser, info, baseURL!, 'member', '/home');
  await expect(member.getByRole('banner')).toContainText('Test Member');
  await expect(member.getByRole('banner')).not.toContainText('Test User');
  await member.context().close();
});

test('"?" and the header button open the keyboard shortcuts; Esc closes and focus returns', async ({ page }, info) => {
  const dir = await sampleFolder(page, info, 'keys');
  await page.goto(`/home${dir}`);
  await row(page, 'notes.txt').focus();
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  for (const text of ['Open', 'Rename', 'Move to trash', 'Select', 'Open the item menu', 'Show this help']) {
    await expect(help.getByRole('row').filter({ hasText: text }).first()).toBeVisible();
  }
  await expect(help.getByText('F2')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  await expect(row(page, 'notes.txt')).toBeFocused();

  // "?" typed into a field is just text.
  const search = page.getByRole('combobox', { name: /Search/ });
  await search.fill('');
  await search.press('?');
  await expect(search).toHaveValue('?');
  await expect(help).toHaveCount(0);

  const button = page.getByRole('button', { name: 'Keyboard shortcuts' });
  await button.click();
  await expect(help).toBeVisible();
  await help.getByRole('button', { name: 'Close' }).click();
  await expect(help).toHaveCount(0);
  await expect(button).toBeFocused();
});

test('the gallery is one tab stop; arrow keys move between tiles', async ({ page }, info) => {
  test.skip(mobile(info), 'keyboard');
  const dir = await sampleFolder(page, info, 'gallerykeys');
  await page.goto(`/home${dir}`);
  await page.getByRole('button', { name: 'Gallery' }).click();
  const tiles = page.getByRole('list', { name: /Gallery/ }).getByRole('button');
  await expect(tiles).toHaveCount(3);
  await expect(tiles.nth(0)).toHaveAttribute('tabindex', '0');
  await expect(tiles.nth(1)).toHaveAttribute('tabindex', '-1');
  await tiles.nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tiles.nth(1)).toBeFocused();
  await expect(tiles.nth(1)).toHaveAttribute('tabindex', '0');
  await expect(tiles.nth(0)).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('End');
  await expect(tiles.nth(2)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tiles.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tiles.nth(0)).toBeFocused();
  await page.getByRole('button', { name: 'List' }).click();
});

test('back and forward (browser or mouse buttons) walk the folder history', async ({ page }, info) => {
  const dir = await sampleFolder(page, info, 'history');
  await page.goto(`/home${dir}`);
  await row(page, 'Inner').getByRole('button', { name: 'Inner', exact: true }).click();
  await expect(crumbs(page).getByRole('link', { name: 'Inner' })).toBeVisible();
  await expect(page.getByText('This folder is empty.')).toBeVisible();
  await page.goBack();
  await expect(row(page, 'notes.txt')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/home${dir}$`));
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/home${dir}/Inner$`));
  await expect(page.getByText('This folder is empty.')).toBeVisible();
});

// Screenshot baselines of the list views in both themes and all three languages (the folder view is in
// settings.spec.ts). Their lists come from fixed data, so nothing changes between runs.
const fixed = '2026-03-04T09:30:00.000Z';
const lists: Record<string, [string, unknown]> = {
  trash: ['**/api/v1/trash', { totalSize: 3_400_000, retentionDays: 30, items: [
    { id: 'a'.repeat(32), name: 'Budget.ods', originalPath: '/Finance/Budget.ods', type: 'file', size: 3_000_000, deletedAt: fixed },
    { id: 'b'.repeat(32), name: 'Drafts', originalPath: '/Drafts', type: 'directory', size: 400_000, deletedAt: fixed }] }],
  recent: ['**/api/v1/recent', { items: [
    { source: 'home', name: 'Report.txt', path: '/Screens/Report.txt', type: 'file', changedAt: fixed },
    { source: 'home', name: 'Screens', path: '/Screens', type: 'directory', changedAt: fixed }] }],
  shared: ['**/api/v1/shares/incoming', { items: [
    { id: 'c'.repeat(32), source: `share:${'c'.repeat(32)}`, name: 'Holiday', type: 'directory', access: 'edit',
      owner: { id: 'x', displayName: 'Test Member' }, createdAt: fixed, orphaned: false }] }],
};
for (const theme of ['light', 'dark'] as const) {
  for (const locale of ['de-du', 'de-sie', 'en'] as const) {
    test(`list views screenshot: ${theme}, ${locale}`, async ({ page }) => {
      for (const [url, body] of Object.values(lists)) {
        await page.route(url, (route) => route.request().method() === 'GET'
          ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }) : route.fallback());
      }
      await putSettings(page, { locale, theme });
      for (const view of Object.keys(lists)) {
        await page.goto(`/${view}`);
        const section = page.locator('main section').first();
        await expect(section.locator('tbody tr').first()).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await expect(section).toHaveScreenshot(`${view}-${theme}-${locale}.png`, { mask: [section.locator('td.date')], animations: 'disabled', caret: 'hide' });
      }
    });
  }
}
