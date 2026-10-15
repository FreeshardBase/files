import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openPlaces } from './places.ts';

// #151: OneDrive and SharePoint over Microsoft Graph, browsed live through the same folder view as the home. Runs
// against the cloud server (e2e/cloudServer.ts), whose OneDrive and SharePoint providers talk to the fake Graph
// (server/test/support/fakeGraph.ts): OneDrive /Documents/Plan 2027.txt; SharePoint sites "Team Site" (libraries
// Documents with /Projects/brief.txt, and Archive) and "Marketing".
test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const row = (page: Page, name: string) => page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });

/** Signs in as testuser and removes connections an earlier test or project left (both projects share the server). */
async function signedIn(page: Page) {
  await page.goto('/auth/login?returnTo=%2Fconnections');
  await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
    expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
  }
  await page.reload();
  await expect(page.getByText(/noch kein Cloud-Konto verbunden|not connected a cloud account yet/)).toBeVisible();
}

/** The browser never talks to Microsoft (here: the fake's Graph and its pre-signed URLs), only to the shard. */
function watchGraph(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => { if (/\/graph(-dl|-upload|-monitor)?\//.test(new URL(r.url()).pathname)) seen.push(r.url()); });
  return seen;
}

test('connect OneDrive with one click and open a file with the same bytes', async ({ page }) => {
  const graph = watchGraph(page);
  await signedIn(page);
  // One-click pairing (#87): the page asks for no token, nothing to paste.
  await expect(page.locator('section.connections').locator('input, textarea')).toHaveCount(0);
  await expect(page.getByLabel(/token/i)).toHaveCount(0);
  await page.getByRole('button', { name: /OneDrive verbinden|Connect OneDrive/ }).click();
  await expect(page.getByRole('heading', { name: 'Fake Cloud' })).toBeVisible(); // the fake's consent page stands in for Microsoft's
  await page.getByRole('button', { name: 'Allow' }).click();

  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  await openPlaces(page);
  await expect(nav(page).getByRole('link', { name: /testuser@example\.com/ })).toContainText('OneDrive');
  await row(page, 'Documents').getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}\/Documents$/);

  const name = 'Plan 2027.txt';
  await page.getByRole('link', { name, exact: true }).click();
  const preview = page.getByRole('dialog', { name, exact: true });
  await expect(preview.locator('pre')).toHaveText('next year, from onedrive');
  const [download] = await Promise.all([page.waitForEvent('download'),
    preview.getByRole('link', { name: /^(Herunterladen|Download)$/ }).click()]);
  expect(download.suggestedFilename()).toBe(name);
  expect(readFileSync(await download.path()).toString()).toBe('next year, from onedrive');
  expect(graph).toEqual([]);
});

test('connect SharePoint, pick a site\'s library in the picker, and browse it', async ({ page }) => {
  const graph = watchGraph(page);
  await signedIn(page);
  await page.getByRole('button', { name: /SharePoint verbinden|Connect SharePoint/ }).click();
  await page.getByRole('button', { name: 'Allow' }).click();

  // Back on "Cloud accounts" with the picker open; it asks for no token either (#87).
  await expect(page).toHaveURL(/\/connections$/);
  const picker = page.getByRole('dialog', { name: /SharePoint-Bibliothek wählen|Choose a SharePoint library/ });
  await expect(picker).toBeVisible();
  await expect(picker).toHaveAttribute('aria-modal', 'true');
  await expect(picker.locator('textarea, input[type="password"]')).toHaveCount(0);
  await expect(picker.getByRole('searchbox')).toBeFocused();
  await expect(picker.getByRole('radio')).toHaveCount(2);

  // Esc closes it; the connection waits for its library and offers to choose one.
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  const conn = page.locator('tbody tr', { hasText: 'testuser@example.com' });
  await expect(conn).toContainText(/Noch keine Bibliothek gewählt|No library chosen yet/);
  await expect(conn.getByRole('link', { name: /öffnen|Open/ })).toHaveCount(0);
  await conn.getByRole('button', { name: /Bibliothek für testuser@example\.com wählen|Choose a library for testuser@example\.com/ }).click();
  await expect(picker).toBeVisible();

  // Find the site, pick it, then its library.
  await picker.getByRole('searchbox').fill('team');
  await picker.getByRole('button', { name: /^(Suchen|Search)$/ }).click();
  await expect(picker.getByRole('radio')).toHaveCount(1);
  const connect = picker.getByRole('button', { name: /Bibliothek verbinden|Connect library/ });
  await expect(connect).toBeDisabled();
  await picker.getByRole('radio', { name: /Team Site/ }).check();
  await expect(picker.getByRole('group', { name: /Bibliotheken|Libraries/ }).getByRole('radio')).toHaveCount(2);
  await picker.getByRole('radio', { name: 'Documents', exact: true }).check();
  await connect.click();

  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  await openPlaces(page);
  const link = nav(page).getByRole('link', { name: /testuser@example\.com/ });
  await expect(link).toContainText('SharePoint');
  await expect(link).toContainText('Team Site / Documents');
  await row(page, 'Projects').getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('link', { name: 'brief.txt', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'brief.txt', exact: true }).locator('pre')).toHaveText('the team brief, from sharepoint');
  expect(graph).toEqual([]);
});
