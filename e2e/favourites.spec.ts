import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openPlaces } from './places.ts';

// #155: favourites across sources. A folder of the home is starred from its row, a file of the generic fake cloud
// (e2e/cloudServer.ts, /report.txt) from its action menu; the details drawer shows the state; both open from the
// Favourites view. Unlinking the connection leaves its favourite in the list as unavailable. Both projects share one
// server and one `testuser`, so each test first clears what an earlier one left.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const crumbs = (page: Page) => page.getByRole('navigation', { name: /Pfad|Path/ });
const row = (page: Page, name: string) => page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const favLink = (page: Page) => nav(page).getByRole('link', { name: /^(Favoriten|Favourites)$/ });

test.describe('with a cloud connection', () => {
  test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

  test('star a home folder and a cloud file, open both from Favourites, unlink the cloud', async ({ page }, info) => {
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await page.goto('/auth/login?returnTo=%2Fconnections');
    await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
    const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
    const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
    for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
      expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
    }
    for (const f of (await (await page.request.get('/api/v1/favourites')).json()).items as { id: number }[]) {
      expect((await page.request.delete(`/api/v1/favourites/${f.id}`, { headers })).status()).toBe(204);
    }
    const dir = `fav-${tag(info)}`;
    expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);

    // The home folder, from the star in its row.
    await openPlaces(page);
    await nav(page).getByRole('link', { name: /Mein Speicher|My storage/ }).click();
    const star = row(page, dir).getByRole('button', { name: new RegExp(`(Favorit|Favourite): ${dir}`) });
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('status')).toContainText(/zu den Favoriten hinzugefügt|added to favourites/);

    // The cloud file, from its action menu; the details drawer shows it is a favourite now.
    await openPlaces(page);
    await page.getByRole('link', { name: /Cloud-Konten|Cloud accounts/ }).first().click();
    await page.getByRole('button', { name: /Fake Cloud verbinden|Connect Fake Cloud/ }).click();
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
    const conn = new URL(page.url()).pathname.slice(1);
    await row(page, 'report.txt').getByRole('button', { name: /(Aktionen für|Actions for) report\.txt/ }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: /Zu Favoriten hinzufügen|Add to favourites/ }).click();
    await expect(row(page, 'report.txt').getByRole('button', { name: /(Favorit|Favourite): report\.txt/ }))
      .toHaveAttribute('aria-pressed', 'true');
    await row(page, 'report.txt').getByRole('button', { name: /(Aktionen für|Actions for) report\.txt/ }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: /^(Details)$/ }).click();
    const drawer = page.getByRole('dialog', { name: /report\.txt/ });
    const drawerStar = drawer.getByRole('button', { name: /^(Favorit|Favourite)$/ });
    await expect(drawerStar).toHaveAttribute('aria-pressed', 'true');
    // The drawer's star is the same toggle: off and on again, and the row follows.
    await drawerStar.click();
    await expect(drawerStar).toHaveAttribute('aria-pressed', 'false');
    await expect(row(page, 'report.txt').getByRole('button', { name: /(Favorit|Favourite): report\.txt/, includeHidden: true }))
      .toHaveAttribute('aria-pressed', 'false');
    await drawerStar.click();
    await expect(drawerStar).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);

    // Favourites lists both, in the order they were starred; each opens.
    await openPlaces(page);
    await favLink(page).click();
    await expect(page).toHaveURL(/\/favourites$/);
    await expect(page.getByRole('heading', { name: /^(Favoriten|Favourites)$/ })).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(page.locator('tbody tr').nth(0)).toContainText(dir);
    await expect(page.locator('tbody tr').nth(1)).toContainText('report.txt');
    await expect(row(page, 'report.txt').locator('.origin')).toContainText(/Fake Cloud/);

    await row(page, dir).getByRole('link', { name: new RegExp(`^(${dir} öffnen|Open ${dir})$`) }).click();
    await expect(page).toHaveURL(new RegExp(`/home/${dir}$`));
    await expect(crumbs(page)).toContainText(dir);

    await openPlaces(page);
    await favLink(page).click();
    await row(page, 'report.txt').getByRole('link', { name: /^(report\.txt öffnen|Open report\.txt)$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/${conn}\\?select=`));
    await expect(row(page, 'report.txt')).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'report.txt')).toBeFocused();

    // Unlinked: the cloud favourite stays, marked unavailable, with no way to open it; it can be removed.
    expect((await page.request.delete(`/api/v1/connections/${conn.slice('conn:'.length)}`, { headers })).status()).toBe(204);
    await page.goto('/favourites');
    await expect(row(page, 'report.txt')).toContainText(/Nicht verfügbar|Unavailable/);
    await expect(row(page, 'report.txt').getByRole('link')).toHaveCount(0);
    await row(page, 'report.txt').getByRole('button', { name: /^(report\.txt aus den Favoriten entfernen|Remove report\.txt from favourites)$/ }).click();
    await expect(row(page, 'report.txt')).toHaveCount(0);
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await openPlaces(page);
    await expect(favLink(page)).toHaveClass(/active/);
    expect(dialogs).toEqual([]);
  });
});

test('an empty Favourites view shows its own empty-state text, not the folder one (#127)', async ({ page }) => {
  await page.goto('/auth/login?login_hint=member&returnTo=%2Ffavourites');
  await expect(page).toHaveURL(/\/favourites$/);
  await expect(page.getByRole('heading', { name: /^(Favoriten|Favourites)$/ })).toBeVisible();
  await expect(page.getByText(/Noch keine Favoriten\.|No favourites yet\./)).toBeVisible();
  await expect(page.getByText(/Dieser Ordner ist leer\.|This folder is empty\./)).toHaveCount(0);
  await expect(page.locator('table')).toHaveCount(0);
  await openPlaces(page);
  await expect(favLink(page)).toHaveClass(/active/);
});
