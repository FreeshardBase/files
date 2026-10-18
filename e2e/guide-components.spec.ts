import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

// #241: the guide's components where Files had none or an ad-hoc one. The toast for action feedback (PDF p.16), the
// dropdown menu with the destructive item last under a hairline (p.18), the segmented "List / Gallery" control (p.19)
// and the outline pill with a status dot (p.15). Each check runs on desktop and phone (the two projects) and in both
// themes; colours are compared with the theme's own tokens, resolved in the page.

const SCHEMES = ['light', 'dark'] as const;
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const mobile = (info: TestInfo) => info.project.name.startsWith('mobile');
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const menuButton = (page: Page, name: string) => row(page, name).getByRole('button', { name: /^(Actions for|Aktionen für) / });

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
async function folderWithFiles(page: Page, info: TestInfo, prefix: string, scheme: string): Promise<string> {
  const dir = `/${prefix}-${scheme}-${tag(info)}`;
  await mkdir(page, dir);
  await putFile(page, `${dir}/ledger.csv`, 'a,b\n');
  await putFile(page, `${dir}/notes.txt`, 'notes\n');
  return dir;
}
async function openFolder(page: Page, dir: string) {
  await page.goto(`/home${dir}`);
  await expect(row(page, 'ledger.csv')).toBeVisible();
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
const style = (l: Locator, prop: string, pseudo?: string) =>
  l.evaluate((el, [p, ps]) => getComputedStyle(el, ps).getPropertyValue(p!), [prop, pseudo ?? null] as const);

test.beforeEach(async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('action feedback is the guide toast: surface, hairline, teal or danger edge, a close X, success fades after 5 s (#241 K1)', async ({ page }, info) => {
  await page.clock.install();
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = await folderWithFiles(page, info, 'toast', scheme);
    await openFolder(page, dir);
    const toast = page.locator('.toast');
    const status = page.getByRole('status');

    // Success: the favourite is confirmed in a toast at the bottom right of the window.
    await menuButton(page, 'ledger.csv').click();
    await page.getByRole('menuitem', { name: /Add to favourites|Zu Favoriten hinzufügen/ }).click();
    await expect(status).toContainText(/ledger\.csv/);
    await expect(toast).toBeVisible();
    expect(await toast.getAttribute('data-kind')).toBe('success');
    expect(await style(toast, 'background-color')).toBe(await resolved(page, 'var(--surface)'));
    expect(await style(toast, 'border-top-width')).toBe('1px');
    expect(await style(toast, 'border-top-color')).toBe(await resolved(page, 'var(--border)'));
    expect(await style(toast, 'border-left-width')).toBe('3px');
    expect(await style(toast, 'border-left-color')).toBe(await resolved(page, 'var(--data)'));
    expect(await style(toast, 'border-top-right-radius')).toBe('10px');
    expect(await style(toast, 'position')).toBe('fixed');
    const box = (await toast.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(vp.width - (box.x + box.width)).toBeLessThanOrEqual(24);
    expect(vp.height - (box.y + box.height)).toBeLessThanOrEqual(24);

    // The close X sits in the toast's bottom-right corner and dismisses it.
    const close = toast.getByRole('button', { name: /Dismiss message|Meldung schließen/ });
    const x = (await close.boundingBox())!;
    expect(x.x + x.width).toBeGreaterThan(box.x + box.width - 60);
    expect(x.y + x.height).toBeGreaterThan(box.y + box.height - 60);
    await close.click();
    await expect(toast).toBeHidden();
    await expect(status).toHaveText('');

    // A success fades on its own after about 5 s, not before.
    await menuButton(page, 'ledger.csv').click();
    await page.getByRole('menuitem', { name: /Remove from favourites|Aus den Favoriten entfernen/ }).click();
    await expect(toast).toBeVisible();
    await page.clock.runFor(3000);
    await expect(toast).toBeVisible();
    await page.clock.runFor(2500);
    await expect(toast).toBeHidden();

    // An error takes the danger edge and stays until it is dismissed.
    await page.route('**/api/v1/sources/home/copy', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL' }) }));
    await menuButton(page, 'notes.txt').click();
    await page.getByRole('menuitem', { name: /^(Copy|Kopieren)$/ }).click();
    await page.getByRole('button', { name: /Copy here|Hierher kopieren/ }).click();
    await expect(status).toContainText(/0/);
    await expect(toast).toBeVisible();
    expect(await toast.getAttribute('data-kind')).toBe('error');
    expect(await style(toast, 'border-left-color')).toBe(await resolved(page, 'var(--danger)'));
    await page.clock.runFor(8000);
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: /Dismiss message|Meldung schließen/ }).click();
    await expect(toast).toBeHidden();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('the item menu: open and look actions first, trash last under a hairline in danger, a 5 % ink highlight (#241 K2)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = await folderWithFiles(page, info, 'menu', scheme);
    await openFolder(page, dir);
    await menuButton(page, 'ledger.csv').click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText([/Download|Herunterladen/, /Share|Freigeben|Teilen/, 'Details',
      /Rename|Umbenennen/, /Move|Verschieben/, /Copy|Kopieren/, /Move to…|Verschieben nach/, /Copy to…|Kopieren nach/,
      /Add to favourites|Zu Favoriten hinzufügen/,
      /Move to trash|In den Papierkorb/]);
    const separator = menu.getByRole('separator');
    await expect(separator).toHaveCount(1);
    expect(await style(separator, 'border-top-width')).toBe('1px');
    expect(await style(separator, 'border-top-color')).toBe(await resolved(page, 'var(--border)'));
    // The hairline sits directly above the trash entry.
    const sep = (await separator.boundingBox())!;
    const trash = menu.getByRole('menuitem', { name: /Move to trash|In den Papierkorb/ });
    const tb = (await trash.boundingBox())!;
    expect(tb.y).toBeGreaterThanOrEqual(sep.y + sep.height - 1);
    expect(tb.y - (sep.y + sep.height)).toBeLessThanOrEqual(8);
    expect(await style(trash, 'color')).toBe(await resolved(page, 'var(--danger)'));
    // The focused entry rests on a 5 % ink tint.
    const first = menu.getByRole('menuitem').first();
    await expect(first).toBeFocused();
    expect(await style(first, 'background-color')).toBe(await resolved(page, 'color-mix(in srgb, var(--ink) 5%, transparent)'));
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  }
});

test('"List / Gallery" is one segmented control; the phone shows line icons with names (#241 K3)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    const dir = await folderWithFiles(page, info, 'segmented', scheme);
    await openFolder(page, dir);
    const group = page.getByRole('group', { name: /View|Ansicht/ });
    await expect(group).toHaveClass(/segmented/);
    expect(await style(group, 'border-top-width')).toBe('1px');
    expect(await style(group, 'border-top-color')).toBe(await resolved(page, 'var(--border)'));
    const list = group.getByRole('button', { name: /^(List|Liste)$/ });
    const gallery = group.getByRole('button', { name: /^(Gallery|Galerie)$/ });
    await list.click();
    await expect(list).toHaveAttribute('aria-pressed', 'true');
    // The segments share the group's border: no gap between them.
    const [a, b] = [(await list.boundingBox())!, (await gallery.boundingBox())!];
    expect(Math.abs(b.x - (a.x + a.width))).toBeLessThanOrEqual(1);
    expect(await style(list, 'background-color')).toBe(await resolved(page, 'var(--surface)'));
    expect(await style(list, 'border-top-color')).toBe(await resolved(page, 'var(--border)'));
    expect(await style(gallery, 'background-color')).toBe('rgba(0, 0, 0, 0)');
    expect(await style(gallery, 'border-top-color')).toBe('rgba(0, 0, 0, 0)');
    await gallery.click();
    await expect(gallery).toHaveAttribute('aria-pressed', 'true');
    expect(await style(gallery, 'background-color')).toBe(await resolved(page, 'var(--surface)'));
    expect(await style(list, 'background-color')).toBe('rgba(0, 0, 0, 0)');
    // Text on the desktop, line icons on the phone; the names stay either way.
    for (const button of [list, gallery]) {
      await expect(button.locator('.icon')).toBeVisible({ visible: mobile(info) });
      await expect(button.locator('.segment-text')).toBeVisible({ visible: !mobile(info) });
    }
    await list.click();
  }
});

/** The pill is an outline with the tile's hairline; its dot is the status colour. */
async function expectPill(page: Page, pill: Locator, dot: string) {
  await expect(pill).toBeVisible();
  await expect(pill).toHaveClass(/fs-pill/);
  expect(await style(pill, 'border-top-width')).toBe('1px');
  expect(await style(pill, 'background-color')).toBe('rgba(0, 0, 0, 0)');
  expect(await style(pill, 'width', '::before')).toBe('6px');
  expect(await style(pill, 'background-color', '::before')).toBe(await resolved(page, dot));
}

test('statuses, access and role are outline pills with a dot (#241 K4)', async ({ page }) => {
  const id = (n: number) => String(n).repeat(32);
  const at = '2026-10-01T10:00:00.000Z';
  const conn = (n: number, status: string) => ({ id: id(n), source: `conn:${id(n)}`, provider: 'fake',
    providerName: 'Fake Cloud', account: `testuser${n}@example.com`, status, createdAt: at });
  const items = [conn(1, 'ok'), conn(2, 'reauth')];
  await page.route('**/api/v1/connections', (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, providers: [] }) }) : route.fallback());
  await page.route('**/api/v1/connections/*/check', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(items.find((c) => route.request().url().includes(c.id))) }));
  const owner = { id: 'member-1', displayName: 'Test User', email: 'testuser@example.com' };
  await page.route('**/api/v1/shares/incoming', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{ id: 's1', source: 'share:s1', name: 'Budget', type: 'directory', access: 'edit',
      owner, createdAt: at, orphaned: false }] }) }));

  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/connections');
    const connRow = (n: number) => page.locator('tbody tr', { hasText: `testuser${n}@example.com` });
    await expectPill(page, connRow(1).locator('.connection-status .fs-pill'), 'var(--data)');
    await expect(connRow(1).locator('.fs-pill')).toHaveText(/Connected|Verbunden/);
    await expectPill(page, connRow(2).locator('.connection-status .fs-pill'), 'var(--danger)');

    await page.goto('/members');
    await expectPill(page, page.locator('tbody .fs-pill', { hasText: /Admin/i }).first(), 'var(--ink-muted)');

    await page.goto('/shared');
    await expectPill(page, page.locator('tbody tr', { hasText: 'Budget' }).locator('.fs-pill'), 'var(--ink-muted)');
    await expect(page.locator('tbody tr', { hasText: 'Budget' }).locator('.fs-pill')).toHaveText(/Can edit|Darf bearbeiten/);
  }
});
