import { expect, test, type Page, type TestInfo } from '@playwright/test';

// #408: every list view starts its content the same distance under the title. An empty status line above the list
// pushed Favourites, Shared with me, My shares and a tag view ~32 px further down than Recent.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;

/** Distance from the title's bottom to the top of the first visible content below the toolbar, the live region aside. */
async function gapUnderTitle(page: Page, path: string): Promise<number> {
  await page.goto(path);
  await expect(page.locator('.page h1.view-title')).toBeVisible();
  await expect(page.locator('.row-skeleton')).toHaveCount(0);
  return page.evaluate(() => {
    const section = document.querySelector('.page')!;
    const title = section.querySelector('h1.view-title')!.getBoundingClientRect();
    const content = [...section.children].find((el) => !el.classList.contains('toolbar')
      && el.getAttribute('role') !== 'status' && el.getBoundingClientRect().height > 0);
    if (!content) throw new Error('no content under the title');
    return content.getBoundingClientRect().top - title.bottom;
  });
}

test('#408: Favourites, Shared with me, My shares and a tag view start as close under the title as Recent', async ({ page }, info) => {
  test.skip(!!info.project.use.isMobile, 'desktop layout');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/home');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  const dir = `title-gap-${tag(info)}`;
  const name = `Gap ${tag(info)}`;
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  expect([200, 201]).toContain((await page.request.post('/api/v1/favourites', { headers, data: { source: 'home', path: `/${dir}` } })).status());
  expect((await page.request.post('/api/v1/tags/add', { headers, data: { source: 'home', paths: [`/${dir}`], tag: name } })).status()).toBeLessThan(300);

  const recent = await gapUnderTitle(page, '/recent');
  for (const path of ['/favourites', '/shared', '/my-shares', `/tags/${encodeURIComponent(name)}`]) {
    expect(Math.abs(await gapUnderTitle(page, path) - recent), `${path} vs /recent (${recent} px)`).toBeLessThanOrEqual(4);
  }
});
