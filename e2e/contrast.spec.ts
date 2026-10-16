import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

// #243: contrast and dark-mode parity. Control boundaries reach 3:1 on both grounds (V1), the light amber keeps AA on
// both (V2), the usage bar is visible in both themes with a fill for any usage and its percentage beside it (V3),
// checkboxes are the guide's outline box rather than the browser's grey square (V4), and the dialog scrim is the paper
// at 80 % without a filter (V5). Each check runs on desktop and phone (the two projects) and in both themes; colours
// are compared with the theme's own tokens, resolved in the page.

const SCHEMES = ['light', 'dark'] as const;
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });

async function headersOf(page: Page) {
  const me = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string; id: string };
  return { id: me.id, headers: { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin } };
}
async function folderWithFile(page: Page, info: TestInfo, prefix: string, scheme: string): Promise<string> {
  const { headers } = await headersOf(page);
  const dir = `/${prefix}-${scheme}-${tag(info)}`;
  const mk = await page.request.post('/api/v1/sources/home/mkdir', { data: { path: dir }, headers });
  expect([201, 409]).toContain(mk.status());
  const put = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`${dir}/ledger.csv`)}&onCollision=replace`,
    { data: Buffer.from('a,b\n'), headers: { ...headers, 'content-type': 'application/octet-stream' } });
  expect(put.status(), await put.text()).toBeLessThan(300);
  created.push(dir);
  return dir;
}
/** Folders this spec made in the home root; removed after each test so other specs' rows stay in a phone's window. */
const created: string[] = [];
async function useScheme(page: Page, scheme: (typeof SCHEMES)[number]) {
  await page.emulateMedia({ colorScheme: scheme });
  await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
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

/** WCAG 2 contrast ratio of two opaque `rgb(…)` colours. */
function contrast(a: string, b: string): number {
  const lum = (css: string) => {
    const [r, g, bl] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
      const c = Number(v) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
async function grounds(page: Page) {
  return { bg: await resolved(page, 'var(--bg)'), surface: await resolved(page, 'var(--surface)') };
}
/** The boundary colour of a control has 3:1 against the paper and the surface (WCAG 1.4.11). */
async function expectBoundary(page: Page, control: Locator, what: string) {
  const { bg, surface } = await grounds(page);
  // Buttons change their border over a short transition after a theme switch, so the check polls until it settles.
  await expect.poll(async () => contrast(await style(control, 'border-top-color'), bg), { message: `${what} on the paper` }).toBeGreaterThanOrEqual(3);
  await expect.poll(async () => contrast(await style(control, 'border-top-color'), surface), { message: `${what} on the surface` }).toBeGreaterThanOrEqual(3);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
});
test.afterEach(async ({ page }) => {
  if (created.length === 0) return;
  const { headers } = await headersOf(page);
  const r = await page.request.post('/api/v1/sources/home/delete', { data: { paths: created.splice(0) }, headers });
  expect(r.status(), await r.text()).toBe(204);
});

test('fields, selects and outline buttons have a boundary of 3:1 on paper and surface; the amber keeps AA (#243 V1, V2)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await useScheme(page, scheme);
    const dir = await folderWithFile(page, info, 'contrast', scheme);
    await page.goto(`/home${dir}`);
    await expect(row(page, 'ledger.csv')).toBeVisible();

    await expectBoundary(page, page.getByRole('combobox', { name: /Suche|Search/ }).first(), 'the search field');
    await expectBoundary(page, page.locator('select.sort-menu'), 'the sort select');
    await expectBoundary(page, page.locator('.toolbar .button:not(.primary):not(.danger)').first(), 'an outline button');

    // The forward action's amber label passes AA for small text on both grounds.
    const { bg, surface } = await grounds(page);
    const amber = await resolved(page, 'var(--accent)');
    expect(contrast(amber, bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(amber, surface)).toBeGreaterThanOrEqual(4.5);
  }
});

test('a checkbox is the guide outline box in both themes and fills teal when checked (#243 V4)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await useScheme(page, scheme);
    const dir = await folderWithFile(page, info, 'checkbox', scheme);
    await page.goto(`/home${dir}`);
    const box = row(page, 'ledger.csv').getByRole('checkbox');
    await expect(box).toBeVisible();

    expect(await style(box, 'appearance')).toBe('none');
    expect(await style(box, 'background-color')).toBe('rgba(0, 0, 0, 0)');
    // The guide's 1.5 px outline; Chromium snaps a border to whole device pixels, so it computes as 1 px or more.
    expect(parseFloat(await style(box, 'border-top-width'))).toBeGreaterThanOrEqual(1);
    expect(await style(box, 'border-top-style')).toBe('solid');
    expect(await style(box, 'border-top-left-radius')).toBe('5px');
    const b = await box.boundingBox();
    expect(b!.width).toBe(18);
    expect(b!.height).toBe(18);
    await expectBoundary(page, box, 'the unchecked box');

    await box.check();
    await expect(box).toBeChecked();
    const data = await resolved(page, 'var(--data)');
    expect(await style(box, 'background-color')).toBe(data);
    expect(await style(box, 'border-top-color')).toBe(data);
    expect(await style(box, 'background-image')).toMatch(/^url\("data:image\/svg\+xml/);
    await box.uncheck();
  }
});

test('the dialog scrim is the paper at 80 % without a filter (#243 V5)', async ({ page }, info) => {
  for (const scheme of SCHEMES) {
    await useScheme(page, scheme);
    const dir = await folderWithFile(page, info, 'scrim', scheme);
    await page.goto(`/home${dir}`);
    await row(page, 'ledger.csv').getByRole('button', { name: /^(Actions for|Aktionen für) / }).click();
    await page.getByRole('menuitem', { name: /^(Rename|Umbenennen)/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const scrim = page.locator('.app-dialog-scrim');
    expect(await style(scrim, 'background-color')).toBe(await resolved(page, 'color-mix(in srgb, var(--bg) 80%, transparent)'));
    expect(await style(scrim, 'backdrop-filter')).toBe('none');
    expect(await style(scrim, 'filter')).toBe('none');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
});

test('a usage bar shows on its track in both themes, fills at least 2 px for any usage and prints its percentage (#243 V3)', async ({ page }, info) => {
  const { id, headers } = await headersOf(page);
  await folderWithFile(page, info, 'usage', 'any');
  // 1 TB against a few bytes: well under 1 %, which used to draw a 0 px fill.
  expect((await page.request.put(`/api/v1/admin/members/${id}/quota`, { headers, data: { quotaBytes: 1_000_000_000_000 } })).status()).toBe(200);
  try {
    for (const scheme of SCHEMES) {
      await useScheme(page, scheme);
      await page.goto('/storage');
      const bar = page.getByRole('meter', { name: /Belegter Speicher auf dem Shard|Storage used on the shard/ });
      await expect(bar).toBeVisible();
      expect(await style(bar, 'background-color')).toBe(await resolved(page, 'var(--border-cool)'));
      expect((await bar.boundingBox())!.height).toBe(6);
      const fill = bar.locator('span');
      expect((await fill.boundingBox())!.width).toBeGreaterThanOrEqual(2);
      expect(await style(fill, 'background-color')).toBe(await resolved(page, 'var(--data)'));

      const percent = page.locator('.usage-percent').first();
      await expect(percent).toHaveText(/^<\s?1\s?%$/);
      expect(await style(percent, 'font-family')).toMatch(/IBM Plex Mono/);
      const [p, b] = [(await percent.boundingBox())!, (await bar.boundingBox())!];
      expect(p.x).toBeGreaterThanOrEqual(b.x + b.width); // beside the bar, after it
      expect(Math.abs((p.y + p.height / 2) - (b.y + b.height / 2))).toBeLessThan(p.height);
    }
  } finally {
    expect((await page.request.put(`/api/v1/admin/members/${id}/quota`, { headers, data: { quotaBytes: null } })).status()).toBe(200);
  }
});
