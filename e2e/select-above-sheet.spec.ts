import { expect, test, type Page, type TestInfo } from '@playwright/test';

// #406: the item a search result opens (`?select=`) is scrolled fully into sight above the phone's selection sheet,
// even when it is only partly hidden under it in a short folder.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const crumbs = (page: Page) => page.getByRole('navigation', { name: /Pfad|Path/ });
const bar = (page: Page) => page.getByRole('group', { name: /^(Aktionen für die Auswahl|Actions for the selection)$/ });
const box = (page: Page) => page.getByRole('combobox', { name: /Dateien nach Namen suchen|Search files by name/ });
const results = (page: Page) => page.getByRole('listbox', { name: /Suchergebnisse|Search results/ });

async function setUp(page: Page, dir: string, files: string[]) {
  await page.goto('/');
  await expect(crumbs(page)).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  for (const f of files) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${f}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from('x') });
    expect(r.status()).toBe(201);
  }
}

for (const view of ['list', 'gallery'] as const) {
  test(`#406 the selected ${view} item of a short folder is not hidden under the selection sheet`, async ({ page }, info) => {
    test.skip(!info.project.name.startsWith('mobile'), 'the sheet is fixed at the bottom only on the phone');
    const dir = `select-sheet-${view}-${tag(info)}`;
    const plan = `plan ${view} ${tag(info)}.txt`;
    const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt', plan];
    await setUp(page, dir, files);
    await page.goto(`/home/${encodeURIComponent(dir)}`);
    await expect(crumbs(page)).toContainText(dir);
    const item = view === 'list'
      ? page.locator('tbody tr', { has: page.locator('.name').getByText(plan, { exact: true }) })
      : page.locator('.gallery-tile', { hasText: plan });
    if (view === 'gallery') {
      await page.getByRole('group', { name: /Ansicht|View/ }).getByRole('button', { name: /Galerie|Gallery/ }).click();
      await expect(page.locator('.gallery-tile')).toHaveCount(files.length);
    }
    await expect(item).toBeVisible();
    // The page above the list is taller on a real phone (the issue's folder ends at 747 px of 839): push the list
    // down until its last item ends 20 px above the window's bottom, inside the window but where the sheet will be.
    const vh = page.viewportSize()!.height;
    const before = (await item.boundingBox())!;
    await page.addStyleTag({ content: `.folder-content { padding-top: ${Math.max(0, vh - 20 - (before.y + before.height))}px; }` });

    // Open the folder from a search result, as the issue does; the SPA keeps the style.
    await box(page).fill(plan);
    await results(page).getByRole('option', { name: new RegExp(plan) }).click();
    await expect(page).toHaveURL(/\?select=/);
    await expect(item).toBeFocused();
    await expect(bar(page)).toBeVisible();
    await expect(async () => {
      const r = (await item.boundingBox())!;
      const b = (await bar(page).boundingBox())!;
      expect(r.y + r.height).toBeLessThanOrEqual(b.y + 0.5);
    }).toPass({ timeout: 3000 });
  });
}
