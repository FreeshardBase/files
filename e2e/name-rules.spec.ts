import { expect, test, type Page } from '@playwright/test';
import { openPlaces } from './places.ts';

// #342: OneDrive's name rules before a copy and a rename. A file with `:` pasted into the fake OneDrive (cloud server,
// e2e/cloudServer.ts) asks first: the suggestion `Bericht_ Q3.pdf` with the replaced character highlighted, an editable
// name checked as it is typed, and "skip". A rename to `x:y` is refused with the reason and offers the suggestion.
test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const row = (page: Page, name: string) => page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const dialog = (page: Page) => page.getByRole('dialog', { name: /Name hier nicht erlaubt|Name not allowed here/ });

async function signedIn(page: Page) {
  await page.goto('/auth/login?returnTo=%2Fconnections');
  await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
    expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
  }
  expect((await page.request.post('/api/v1/transfers/clear', { headers })).status()).toBe(204);
  await page.reload();
  return headers;
}

async function copyInto(page: Page, dir: string, name: string) {
  await openPlaces(page);
  await nav(page).getByRole('link', { name: /Mein Speicher|My storage/ }).click();
  await page.getByRole('button', { name: dir, exact: true }).click();
  await row(page, name).getByRole('button', { name: new RegExp(`(Aktionen für|Actions for) ${name.replace(/[.:]/g, '\\$&')}`) }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /^(Kopieren|Copy)$/ }).click();
  await openPlaces(page);
  await nav(page).getByRole('link', { name: /testuser@example\.com/ }).click();
  await page.getByRole('button', { name: dir, exact: true }).click();
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toContainText(dir);
  await page.getByRole('button', { name: /Hierher kopieren \(1\)|Copy here \(1\)/ }).click();
}

test('a file with a colon pasted into OneDrive asks with the suggestion; a rename to x:y is refused', async ({ page }, info) => {
  const headers = await signedIn(page);
  const dir = `names-${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  for (const name of ['Bericht: Q3.pdf', 'Notiz: A.txt']) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/${name}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(name) });
    expect(r.status()).toBe(201);
  }
  await page.getByRole('button', { name: /OneDrive verbinden|Connect OneDrive/ }).click();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  const conn = new URL(page.url()).pathname.slice(1);
  expect((await page.request.post(`/api/v1/sources/${conn}/mkdir`, { headers, data: { path: `/${dir}` } })).status()).toBe(201);

  // The suggestion, its replaced character highlighted, and why.
  await copyInto(page, dir, 'Bericht: Q3.pdf');
  await expect(dialog(page)).toContainText(/„:“ ist bei OneDrive nicht erlaubt\.|“:” is not allowed in OneDrive\./);
  await expect(dialog(page).getByTestId('name-suggestion')).toHaveText('Bericht_ Q3.pdf');
  await expect(dialog(page).getByTestId('name-suggestion').locator('mark')).toHaveText(['_']);
  const field = dialog(page).getByRole('textbox');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Bericht_ Q3.pdf');
  // The edited name is checked as it is typed; a name OneDrive refuses cannot be taken.
  await field.fill('Bericht? Q3.pdf');
  await expect(dialog(page)).toContainText(/„\?“ ist bei OneDrive nicht erlaubt\.|“\?” is not allowed in OneDrive\./);
  await expect(dialog(page).getByRole('button', { name: /^(Übernehmen|Use name)$/ })).toBeDisabled();
  await field.fill('Bericht Q3 final.pdf');
  await field.press('Enter');
  await expect(dialog(page)).toHaveCount(0);
  await expect(row(page, 'Bericht Q3 final.pdf')).toBeVisible({ timeout: 15_000 });

  // "Skip" leaves the item out: nothing is copied.
  await copyInto(page, dir, 'Notiz: A.txt');
  await expect(dialog(page).getByTestId('name-suggestion')).toHaveText('Notiz_ A.txt');
  await dialog(page).getByRole('button', { name: /^(Überspringen|Skip)$/ }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText(/Nichts|Nothing/);
  await expect(row(page, 'Notiz_ A.txt')).toHaveCount(0);

  // A rename in OneDrive to x:y is refused with the reason and offers the suggestion.
  await row(page, 'Bericht Q3 final.pdf').getByRole('button', { name: /(Aktionen für|Actions for) Bericht Q3 final\.pdf/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /Umbenennen|Rename/ }).click();
  const rename = page.getByRole('dialog', { name: /Umbenennen|Rename/ });
  await rename.getByRole('textbox').fill('x:y');
  await expect(rename).toContainText(/„:“ ist bei OneDrive nicht erlaubt\.|“:” is not allowed in OneDrive\./);
  await rename.getByRole('button', { name: /^(Umbenennen|Rename)$/ }).click();
  await expect(rename).toBeVisible();
  await rename.getByRole('button', { name: /Vorschlag übernehmen: x_y|Use suggestion: x_y/ }).click();
  await expect(rename.getByRole('textbox')).toHaveValue('x_y');
  await rename.getByRole('button', { name: /^(Umbenennen|Rename)$/ }).click();
  await expect(row(page, 'x_y')).toBeVisible();
});
