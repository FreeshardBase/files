import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openPlaces } from './places.ts';

// #212: tags across sources. A home file is tagged in the details drawer's chip editor, a file of the generic fake cloud
// (e2e/cloudServer.ts, /report.txt) with the selection bar's "Add tag"; both show the chip in the list (and the home file
// in the gallery), and the chip opens the tag view, which lists both. Both projects share one server and one `testuser`,
// so every tag name carries the project and the connection is made afresh.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const row = (page: Page, name: string) => page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const chip = (page: Page, item: string, name: string) => row(page, item)
  .getByRole('list', { name: new RegExp(`^(Tags von|Tags of) ${item.replace('.', '\\.')}$`) }).getByRole('link', { name });

test.describe('with a cloud connection', () => {
  test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

  test('tag a home file in the drawer and a cloud file from the selection, then open the tag view', async ({ page }, info) => {
    await page.goto('/auth/login?returnTo=%2Fconnections');
    await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
    const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
    const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
    for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
      expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
    }
    const dir = `tags-${tag(info)}`;
    const name = `Project ${tag(info)}`;
    expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
    expect((await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/plan.txt`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: 'the plan' })).status()).toBe(201);

    // The cloud file, from the selection bar.
    await page.getByRole('button', { name: /Fake Cloud verbinden|Connect Fake Cloud/ }).click();
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
    await row(page, 'report.txt').getByRole('checkbox', { name: /(Auswählen|Select) report\.txt/ }).check();
    const bar = page.getByRole('group', { name: /^(Aktionen für die Auswahl|Actions for the selection)$/ });
    await bar.getByRole('button', { name: /^(Tag hinzufügen|Add tag)$/ }).click();
    const addDialog = page.getByRole('dialog', { name: /Tag zu einem Element hinzufügen|Add a tag to one item/ });
    await addDialog.getByRole('combobox', { name: /^Tag$/ }).fill(`  ${name}  `);
    await addDialog.getByRole('button', { name: /^(Tag hinzufügen|Add tag)$/ }).click();
    await expect(addDialog).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText(new RegExp(`„${name}“ zu einem Element|“${name}” added to one item`));
    await expect(chip(page, 'report.txt', name)).toBeVisible();

    // The home file, in the details drawer's chip editor.
    await openPlaces(page);
    await nav(page).getByRole('link', { name: /Mein Speicher|My storage/ }).click();
    await row(page, dir).getByRole('button', { name: dir, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/home/${dir}$`));
    await row(page, 'plan.txt').getByRole('button', { name: /(Aktionen für|Actions for) plan\.txt/ }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: /^(Details)$/ }).click();
    const drawer = page.getByRole('dialog', { name: /plan\.txt/ });
    const field = drawer.getByRole('combobox', { name: /Neuer Tag|New tag/ });
    // The member's existing tag is suggested; another spelling of it adds the same tag.
    await field.fill(name.toUpperCase());
    await field.press('Enter');
    const editor = drawer.getByRole('list', { name: /(Tags von|Tags of) plan\.txt/ });
    await expect(editor.getByRole('link')).toHaveText([name]);
    // A name over 40 characters is refused in the editor and adds nothing.
    await field.fill('x'.repeat(41));
    await drawer.getByRole('button', { name: /^(Tag hinzufügen|Add tag)$/ }).click();
    await expect(drawer.getByRole('alert')).toContainText(/höchstens 40 Zeichen|at most 40 characters/);
    await expect(editor.getByRole('link')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(chip(page, 'plan.txt', name)).toBeVisible();

    // The gallery shows the chip on the tile as well.
    const toggle = page.getByRole('group', { name: /Ansicht|View/ });
    await toggle.getByRole('button', { name: /Galerie|Gallery/ }).click();
    const gallery = page.getByRole('list', { name: /Galerie|Gallery/ });
    await expect(gallery.getByRole('list', { name: /(Tags von|Tags of) plan\.txt/ }).getByRole('link', { name })).toBeVisible();
    await toggle.getByRole('button', { name: /^(Liste|List)$/ }).click();

    // The chip opens the tag view, which lists both items with their places.
    await chip(page, 'plan.txt', name).click();
    await expect(page).toHaveURL(new RegExp(`/tags/${encodeURIComponent(name)}$`));
    await expect(page.getByRole('heading', { name: new RegExp(`^Tag: ${name}$`) })).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(row(page, 'report.txt').locator('.origin')).toContainText(/Fake Cloud/);
    await expect(row(page, 'plan.txt').locator('.origin')).toContainText(new RegExp(`(Mein Speicher|My storage) › ${dir}`));

    // Each opens where it lives; removing the tag takes the item off the view.
    await row(page, 'plan.txt').getByRole('link', { name: /^(plan\.txt öffnen|Open plan\.txt)$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/home/${dir}\\?select=`));
    await page.goBack();
    await row(page, 'report.txt').getByRole('button', { name: new RegExp(`(Tag „${name}“ von|Remove tag “${name}” from) report\\.txt`) }).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByRole('status')).toContainText(/entfernt|removed/);
  });
});

// #307: the tag view resolves the first 500 items of a tag; with more it lists those and says so.
test('the tag view of more than 500 items lists the first 500 and says there are more', async ({ page }, info) => {
  test.slow(); // 502 folders through the API
  await page.goto('/home');
  await expect(nav(page)).toBeAttached();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  const dir = `/tagged-${tag(info)}`;
  const folders = Array.from({ length: 501 }, (_, i) => `${dir}/d-${String(i + 1).padStart(3, '0')}`);
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: dir } })).status()).toBe(201);
  const next = { i: 0 };
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (next.i < folders.length) {
      const r = await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: folders[next.i++] } });
      expect(r.status(), await r.text()).toBe(201);
    }
  }));
  const name = `many-${tag(info)}`;
  const add = async (paths: string[]) => {
    const r = await page.request.post('/api/v1/tags/add', { headers, data: { source: 'home', paths, tag: name } });
    expect(r.status(), await r.text()).toBe(200);
  };
  const note = page.getByText(/^(Nur die ersten 500 Elemente mit diesem Tag werden angezeigt\.|Only the first 500 items with this tag are shown\.)$/);

  await add(folders.slice(0, 500));
  await page.goto(`/tags/${encodeURIComponent(name)}`);
  await expect(page.locator('tbody tr')).toHaveCount(500);
  await expect(page.locator('tbody tr').last().locator('.name')).toHaveText('d-500');
  await expect(note).toHaveCount(0);

  await add(folders.slice(500));
  await page.reload();
  await expect(note).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(500);
  await expect(page.locator('tbody tr').last().locator('.name')).toHaveText('d-500');
  await expect(page.getByText('d-501', { exact: true })).toHaveCount(0);
});
