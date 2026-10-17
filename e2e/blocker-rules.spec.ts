import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';

// #295: Brave's shields hid the share dialog's link and access lists through the generic cosmetic rules `##.share-list`
// and `##.share-heading`. With the vendored rules applied the way a blocker applies them, both lists and their headings
// stay visible.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const row = (page: Page, name: string) =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });

const selectors = readFileSync(new URL('./fixtures/generic-cosmetic-rules.txt', import.meta.url), 'utf8').split('\n')
  .map((l) => l.trim()).filter((l) => l.startsWith('##')).map((l) => l.slice(2));
const blockerCss = `${selectors.join(',\n')} { display: none !important; }`;

test('the share dialog shows its link and access lists under generic share/social hiding rules', async ({ page, browser, baseURL }, info) => {
  expect(selectors).toEqual(expect.arrayContaining(['.share-list', '.share-heading']));
  // The member is known to the shard once they have signed in.
  const ctx = await browser.newContext({ baseURL });
  const m = await ctx.newPage();
  await m.goto('/auth/login?login_hint=member&returnTo=%2F');
  await expect(nav(m)).toBeAttached();
  await ctx.close();

  await page.goto('/');
  await expect(nav(page)).toBeAttached();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  const dir = `/zz-blocker-${tag(info)}`;
  const path = `${dir}/report.txt`;
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: dir } })).status()).toBe(201);
  const put = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=fail`,
    { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from('report') });
  expect(put.status()).toBe(201);
  for (const label of ['First link', 'Second link']) {
    const r = await page.request.post('/api/v1/links', { headers, data: { source: 'home', path, label } });
    expect(r.status(), await r.text()).toBe(201);
  }
  const grantee = ((await (await page.request.get('/api/v1/members')).json()).items as { id: string; displayName: string }[])
    .find((x) => x.displayName === 'Test Member')!.id;
  const share = await page.request.post('/api/v1/shares', { headers, data: { source: 'home', path, grantee, access: 'read' } });
  expect(share.status(), await share.text()).toBe(201);

  await page.goto(`/home${dir}`);
  await expect(row(page, 'report.txt')).toBeVisible();
  await page.addStyleTag({ content: blockerCss });
  await row(page, 'report.txt').getByRole('button', { name: /(Aktionen für|Actions for) report\.txt/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /^(Freigeben|Share)$/ }).click();
  const d = page.getByRole('dialog', { name: /freigeben|Share/ });
  await expect(d).toBeVisible();

  const links = d.getByRole('list', { name: /Öffentliche Links|Public links/ });
  await expect(d.getByRole('heading', { name: /Öffentliche Links|Public links/ })).toBeVisible();
  await expect(links).toBeVisible();
  await expect(links.getByRole('listitem')).toHaveCount(2);
  await expect(links.getByText('First link')).toBeVisible();
  await expect(links.getByText('Second link')).toBeVisible();

  const access = d.getByRole('list', { name: /Wer hat Zugriff|Who has access/ });
  await expect(d.getByRole('heading', { name: /Wer hat Zugriff|Who has access/ })).toBeVisible();
  await expect(access).toBeVisible();
  await expect(access.getByText('Test Member')).toBeVisible();
});
