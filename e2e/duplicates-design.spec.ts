import { randomBytes } from 'node:crypto';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { openPlaces } from './places.ts';

// #384: the duplicates page against the design guide. A group is a list sheet (surface tone, `--border` hairline, rows
// split by `--border`, never the teal `--line`), its size and dates are figures in the mono face, each copy's checkbox
// sits in a 44 px label on the phone, and the "Where to look" legend starts at the column's edge. Dark theme, where
// `--line` is the bright teal.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const mobile = (info: TestInfo) => info.project.name.startsWith('mobile');
const style = (l: Locator, prop: string) => l.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
const MONO = /IBM Plex Mono/;

async function headers(page: Page) {
  const me = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': me.csrfToken, origin: new URL(page.url()).origin };
}
async function putTheme(page: Page, theme: 'dark' | 'system') {
  const r = await page.request.put('/api/v1/settings', { data: { locale: null, theme }, headers: await headers(page) });
  expect(r.status(), await r.text()).toBe(200);
}
async function put(page: Page, path: string, data: Buffer) {
  const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=fail`, {
    headers: { ...await headers(page), 'content-type': 'application/octet-stream' }, data });
  expect(r.status()).toBe(201);
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

test.afterEach(async ({ page }) => { await putTheme(page, 'system'); });

test('#384 duplicates: groups are list sheets, figures in mono, 44 px checkbox labels on the phone', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  await putTheme(page, 'dark');
  // Under one parent that sorts last, so the home's root keeps other tests' rows in place.
  const dir = `zz-duplicates-384/dups-${tag(info)}`;
  const h = await headers(page);
  expect([201, 409]).toContain((await page.request.post('/api/v1/sources/home/mkdir', { headers: h, data: { path: '/zz-duplicates-384' } })).status());
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers: h, data: { path: `/${dir}` } })).status()).toBe(201);
  const same = randomBytes(900);
  const first = `a-${tag(info)}.bin`;
  const second = `b-${tag(info)}.bin`;
  await put(page, `/${dir}/${first}`, same);
  await put(page, `/${dir}/${second}`, same);

  await page.reload();
  const nav = await openPlaces(page);
  await nav.getByRole('link', { name: /^\s*(Doppelte Dateien|Duplicates)\s*$/ }).click();
  await expect(page.getByRole('heading', { name: /^(Doppelte Dateien|Duplicates)$/, level: 1 })).toBeVisible();

  // The legend starts where the checkboxes below it start.
  const sources = page.locator('.duplicates-sources');
  const legendLeft = await sources.locator('legend').evaluate((el) => el.getBoundingClientRect().left);
  const fieldsetLeft = await sources.evaluate((el) => el.getBoundingClientRect().left);
  expect(legendLeft).toBeCloseTo(fieldsetLeft, 0);

  await page.getByRole('button', { name: /^(Doppelte Dateien suchen|Find duplicates|Erneut suchen|Search again)$/ }).click();
  const group = page.locator('.duplicate-group', { has: page.getByText(second, { exact: true }) });
  await expect(group).toBeVisible({ timeout: 30_000 });
  await expect(group.locator('.duplicate-copy')).toHaveCount(2);

  // A list sheet: surface tone and the warm hairline, rows split by it too; the teal `--line` is not a sheet edge.
  const line = await resolved(page, 'var(--line)');
  const border = await resolved(page, 'var(--border)');
  expect(border).not.toBe(line);
  expect(await style(group, 'border-top-color')).toBe(border);
  expect(await style(group, 'background-color')).toBe(await resolved(page, 'var(--surface)'));
  expect(await style(group.locator('.duplicate-copy').nth(1), 'border-top-color')).toBe(border);

  // Figures in the mono face, inside their sentences.
  const sizeFigure = group.getByRole('heading').locator('.value-mono');
  await expect(sizeFigure).toHaveText(/900/);
  expect(await style(sizeFigure, 'font-family')).toMatch(MONO);
  expect(await style(group.getByRole('heading'), 'font-family')).not.toMatch(MONO);
  const dateFigure = group.locator('.duplicate-copy').first().locator('.origin .value-mono');
  await expect(dateFigure).toHaveText(/\d/);
  expect(await style(dateFigure, 'font-family')).toMatch(MONO);

  // Each checkbox sits in a label; on the phone that label is a 44 px target.
  const checkbox = group.getByRole('checkbox', { name: new RegExp(second.replace(/\./g, '\\.')) });
  const label = checkbox.locator('xpath=ancestor::label[1]');
  await expect(label).toHaveClass(/check-target/);
  if (mobile(info)) {
    const b = (await label.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.width).toBeGreaterThanOrEqual(44);
  }
  // The label hands a tap to its checkbox.
  await expect(checkbox).not.toBeChecked();
  await label.click();
  await expect(checkbox).toBeChecked();
});
