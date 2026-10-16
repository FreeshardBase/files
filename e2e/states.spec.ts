import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';

// #240: empty, error, loading and not-found states. The empty folder is the guide's empty state (a 48 px line glyph,
// one sentence, "Hochladen"); an error is the guide's alert banner (PDF p.17: danger hairline, 7 % danger fill, bold
// title, one sentence, one way on) with the toolbar gone; a loading list is a skeleton of six rows; the shell keeps its
// sidebar while /me loads and when it fails; a visitor's page never offers a download it would refuse. Each check runs
// on desktop and phone (the two projects) and in both themes, with colours resolved from the theme's own tokens.

const SCHEMES = ['light', 'dark'] as const;
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const places = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const crumbs = (page: Page) => page.getByRole('navigation', { name: /Pfad|Path/ });
const content = (page: Page) => page.getByRole('region', { name: /Inhalt von|Contents of/ });
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA'; // 22 characters, the shape of a link token; no link has it
// Every folder of this spec lives in one folder that sorts last, so the shared home root stays short for other specs.
const ROOT = '/zz-states';

async function headers(page: Page) {
  const me = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin };
}
async function putSettings(page: Page, locale: 'de-du' | null) {
  const r = await page.request.put('/api/v1/settings', { data: { locale, theme: 'system' }, headers: await headers(page) });
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

/** A CSS colour expression (`var(--data)`, `color-mix(…)`) as the page computes it in the current theme. */
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

/** Holds back every request matching `url` (and `when`) until the returned function is called. */
async function hold(page: Page, url: string, when: (r: Route) => boolean = () => true) {
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let seen!: () => void;
  const held = new Promise<void>((r) => { seen = r; });
  await page.route(url, async (route) => {
    if (!when(route)) return route.fallback();
    seen();
    await released;
    await route.fallback();
  });
  return { held, release };
}
const listOf = (path: string) => (r: Route) => new URL(r.request().url()).searchParams.get('path') === path;

/** The guide's alert banner: danger hairline, 7 % danger fill, a bold title. */
async function expectAlertBanner(page: Page, alert: Locator, title: RegExp) {
  await expect(alert).toBeVisible();
  expect(await style(alert, 'border-top-width')).toBe('1px');
  expect(await style(alert, 'border-top-color')).toBe(await resolved(page, 'var(--danger)'));
  expect(await style(alert, 'background-color')).toBe(await resolved(page, 'color-mix(in srgb, var(--danger) 7%, transparent)'));
  const heading = alert.locator('.alert-title');
  await expect(heading).toHaveText(title);
  expect(Number(await style(heading, 'font-weight'))).toBeGreaterThanOrEqual(600);
}

// The visitor's page, the start and the offline shell have no member setting yet: they follow the browser's language.
test.use({ locale: 'de-DE' });

test.beforeEach(async ({ page }) => {
  await page.goto('/home');
  await expect(places(page)).toBeVisible();
  await putSettings(page, 'de-du');
  await mkdir(page, ROOT);
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await putSettings(page, null);
  // Leave the shared home root and trash as they were: the folder list windows from 200 entries (#225), and other
  // specs expect their own folders to render in the home root.
  const h = await headers(page);
  const del = await page.request.post('/api/v1/sources/home/delete', { data: { paths: [ROOT] }, headers: h });
  expect(del.status(), await del.text()).toBeLessThan(300);
  const trash = await (await page.request.get('/api/v1/trash')).json() as { items: { id: string; originalPath: string }[] };
  const ids = trash.items.filter((i) => i.originalPath === ROOT).map((i) => i.id);
  const purge = await page.request.post('/api/v1/trash/delete', { data: { ids }, headers: h });
  expect(purge.status(), await purge.text()).toBe(204);
});

test('E1: an empty folder and an empty home show the empty state: a 48 px line glyph, one sentence, "Hochladen"', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = `${ROOT}/empty-${scheme}-${tag(info)}`;
    await mkdir(page, dir);
    await page.goto(`/home${dir}`);
    const empty = content(page).locator('.empty-state');
    await expect(empty).toBeVisible();
    await expect(empty.locator('p')).toHaveText('Dieser Ordner ist leer.');
    const glyph = empty.locator('.icon');
    expect(await style(glyph, 'width')).toBe('48px');
    expect(await style(glyph, 'height')).toBe('48px');
    expect(await style(glyph, 'background-color')).toBe(await resolved(page, 'var(--line)'));
    // Centred in the column.
    const box = (await empty.boundingBox())!; const col = (await content(page).boundingBox())!;
    expect(Math.abs((box.x + box.width / 2) - (col.x + col.width / 2))).toBeLessThanOrEqual(2);
    // "Hochladen" is the forward action and opens the file picker; the file lands in this folder.
    const upload = empty.getByRole('button', { name: 'Hochladen' });
    expect(await style(upload, 'border-top-color')).toBe(await resolved(page, 'var(--accent)'));
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), upload.click()]);
    await chooser.setFiles({ name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await expect(row(page, 'first.txt')).toBeVisible();
    await expect(page.locator('.empty-state')).toHaveCount(0);

    // The home root has its own sentence.
    await page.route('**/api/v1/sources/home/list?**', (route) => listOf('/')(route)
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [], access: 'edit' }) })
      : route.fallback());
    await page.goto('/home');
    await expect(content(page).locator('.empty-state p')).toHaveText('Noch nichts hier. Lade deine ersten Dateien hoch.');
    await expect(content(page).locator('.empty-state').getByRole('button', { name: 'Hochladen' })).toBeVisible();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('E2: a missing folder and a server error are alert banners with a way on, and the toolbar is gone', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/home${ROOT}/missing-${scheme}-${tag(info)}`);
    const alert = content(page).getByRole('alert');
    await expectAlertBanner(page, alert, /^Ordner nicht gefunden$/);
    await expect(alert).toContainText('Diesen Ordner gibt es nicht oder nicht mehr.');
    // No dead controls for a folder that does not exist.
    await expect(page.locator('.toolbar')).toHaveCount(0);
    await expect(page.getByText('Ordner hochladen')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Galerie/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Neuer Ordner' })).toHaveCount(0);
    await alert.getByRole('link', { name: 'Zu „Mein Speicher“' }).click();
    await expect(page).toHaveURL(/\/home$/);
    await expect(crumbs(page)).toBeVisible();

    // A server error offers "Erneut versuchen", which loads the folder once the server answers again.
    const dir = `${ROOT}/err-${scheme}-${tag(info)}`;
    await mkdir(page, dir);
    await putFile(page, `${dir}/kept.txt`, 'kept');
    await page.route('**/api/v1/sources/home/list?**', (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL' }) }));
    await page.goto(`/home${dir}`);
    const failed = content(page).getByRole('alert');
    await expectAlertBanner(page, failed, /^Ordner lässt sich nicht öffnen$/);
    await expect(failed).toContainText('Etwas ist schiefgelaufen. Versuch es später noch einmal.');
    await expect(page.locator('.toolbar')).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await failed.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(row(page, 'kept.txt')).toBeVisible();
    await expect(page.locator('.toolbar')).toBeVisible();
  }
});

test('E3: a public link with no downloads left shows only the refusal, no "Herunterladen" and no preview', async ({ page }) => {
  await page.route(`**/s/${TOKEN}/info`, (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ name: 'report.txt', type: 'file', locked: false, size: 5, mime: 'text/plain', downloadsLeft: 0 }) }));
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/s/${TOKEN}`);
    await expect(page.getByTestId('link-name')).toHaveText('report.txt');
    const refusal = page.locator('.link-alert');
    await expect(refusal).toHaveText('Für diesen Link sind keine Downloads mehr übrig.');
    expect(await style(refusal, 'background-color')).toBe(await resolved(page, 'color-mix(in srgb, var(--danger) 7%, transparent)'));
    await expect(page.getByRole('link', { name: 'Herunterladen' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Vorschau öffnen' })).toHaveCount(0);
    // Coming back from a refused download, the refusal is said once.
    await page.goto(`/s/${TOKEN}?error=DOWNLOAD_LIMIT_REACHED`);
    await expect(page.getByTestId('link-name')).toHaveText('report.txt');
    await expect(page.locator('.link-alert')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Herunterladen' })).toHaveCount(0);
  }
});

test('E4: a loading folder and the loading trash show six skeleton rows, busy, with the loading text kept for screen readers', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = `${ROOT}/load-${scheme}-${tag(info)}`;
    await mkdir(page, dir);
    await putFile(page, `${dir}/arrived.txt`, 'here');
    const listing = await hold(page, '**/api/v1/sources/home/list?**', listOf(dir));
    await page.goto(`/home${dir}`);
    await listing.held;
    const skeleton = content(page).locator('.row-skeleton');
    await expect(skeleton).toBeVisible();
    await expect(content(page)).toHaveAttribute('aria-busy', 'true');
    const rows = skeleton.locator('.skeleton-row');
    await expect(rows).toHaveCount(6);
    const bar = rows.first().locator('.skeleton-bar').first();
    expect(await style(bar, 'background-color')).toBe(await resolved(page, 'var(--border)'));
    expect(await style(bar, 'animation-name')).toBe('none');
    const note = content(page).getByRole('status');
    await expect(note).toHaveText('Wird geladen …');
    await expect(note).toHaveClass(/visually-hidden/);
    const skeletonRowHeight = (await rows.first().boundingBox())!.height;
    listing.release();
    await expect(row(page, 'arrived.txt')).toBeVisible();
    await expect(skeleton).toHaveCount(0);
    // The skeleton rows have the height of the rows that replace them, so nothing jumps.
    const realRowHeight = (await row(page, 'arrived.txt').boundingBox())!.height;
    expect(Math.abs(skeletonRowHeight - realRowHeight), `skeleton ${skeletonRowHeight}px, row ${realRowHeight}px`).toBeLessThanOrEqual(1);
    await page.unrouteAll({ behavior: 'ignoreErrors' });

    const trash = await hold(page, '**/api/v1/trash');
    await page.goto('/trash');
    await trash.held;
    await expect(page.locator('main .row-skeleton .skeleton-row')).toHaveCount(6);
    await expect(page.locator('main .row-skeleton')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('main').getByRole('status').filter({ hasText: 'Wird geladen …' })).toHaveClass(/visually-hidden/);
    trash.release();
    await expect(page.locator('main .row-skeleton')).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('E5: while the app starts, the sidebar skeleton and "Wird geladen …" show', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const me = await hold(page, '**/api/v1/me');
    await page.goto('/home');
    await me.held;
    const skeleton = page.locator('.app-nav .nav-skeleton');
    // On the phone the places sit collapsed behind "Orte", as they will once loaded.
    if (info.project.name.startsWith('mobile')) {
      await expect(page.getByRole('button', { name: 'Orte' })).toBeVisible();
      await page.getByRole('button', { name: 'Orte' }).click();
    }
    await expect(skeleton).toBeVisible();
    await expect(skeleton.locator('.skeleton-bar').first()).toBeVisible();
    expect(await style(skeleton.locator('.skeleton-bar').first(), 'background-color')).toBe(await resolved(page, 'var(--border)'));
    await expect(page.locator('main').getByRole('status')).toHaveText('Wird geladen …');
    me.release();
    await expect(places(page).getByRole('link', { name: 'Mein Speicher' })).toBeVisible();
    await expect(skeleton).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('E6: a bad public link token is the danger box with a sentence that says what to do', async ({ page }) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/s/${TOKEN}`);
    const box = page.locator('.link-alert');
    await expectAlertBanner(page, box, /^Dieser Link lässt sich nicht öffnen$/);
    await expect(box).toContainText('Diesen Link gibt es nicht oder nicht mehr. Frag die Person, die ihn dir geschickt hat.');
    await expect(box).toHaveAttribute('role', 'alert');
  }
});

test('E7: without a connection the shell stays: the sidebar, and the alert inside the content column', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.route('**/api/v1/me', (route) => route.abort('internetdisconnected'));
    await page.goto('/home');
    const alert = page.locator('main .page').getByRole('alert');
    await expectAlertBanner(page, alert, /^„Dateien“ lässt sich nicht laden$/);
    await expect(alert).toContainText('Keine Verbindung zum Shard.');
    await expect(page.locator('.app-nav')).toBeVisible();
    if (info.project.name.startsWith('mobile')) await page.getByRole('button', { name: 'Orte' }).click();
    await expect(places(page).getByRole('link', { name: 'Mein Speicher' })).toBeVisible();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await alert.getByRole('button', { name: 'Erneut versuchen' }).click();
    await expect(crumbs(page)).toBeVisible();
  }
});

test('E8: an unknown address shows a not-found view with a way to "Mein Speicher", without redirecting', async ({ page }) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/irgendwas/kaputt');
    const alert = page.locator('main').getByRole('alert');
    await expectAlertBanner(page, alert, /^Seite nicht gefunden$/);
    await expect(page).toHaveURL(/\/irgendwas\/kaputt$/);
    await alert.getByRole('link', { name: 'Zu „Mein Speicher“' }).click();
    await expect(page).toHaveURL(/\/home$/);
    await expect(crumbs(page)).toBeVisible();
  }
});
