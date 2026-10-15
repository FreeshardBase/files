import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const input = { mimeType: 'text/plain' };

test('log in, upload a real file, see it, download the same bytes', async ({ page }, info) => {
  const fileName = `Prüfung #1 50% ${info.project.name}.txt`;
  await page.goto('/');
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();

  await page.getByTestId('upload-input').setInputFiles({ name: fileName, ...input, buffer: Buffer.from('hallo welt') });
  await expect(page.getByRole('status')).toContainText(/1 von 1|1 of 1/);
  const link = page.getByRole('link', { name: fileName });
  await expect(link).toBeVisible();

  // A click previews the file; its Download button downloads it.
  await link.click();
  const preview = page.getByRole('dialog', { name: fileName });
  await expect(preview.locator('pre')).toHaveText('hallo welt');
  const [download] = await Promise.all([page.waitForEvent('download'),
    preview.getByRole('link', { name: /^(Herunterladen|Download)$/ }).click()]);
  expect(download.suggestedFilename()).toBe(fileName);
  expect(readFileSync(await download.path()).toString()).toBe('hallo welt');
});

test('file list is keyboard reachable and operable', async ({ page }, info) => {
  const fileName = `kbd-${info.project.name}.txt`;
  await page.goto('/');
  const files = page.getByTestId('upload-input');
  await files.setInputFiles({ name: fileName, ...input, buffer: Buffer.from('kbd') });
  await expect(page.getByRole('link', { name: fileName })).toBeVisible();
  await files.setInputFiles({ name: `kbd2-${info.project.name}.txt`, ...input, buffer: Buffer.from('kbd') });
  await expect(page.getByRole('link', { name: `kbd2-${info.project.name}.txt` })).toBeVisible();

  const role = () => page.evaluate(() => document.activeElement?.getAttribute('role'));
  const rowName = () => page.evaluate(() => document.activeElement?.querySelector('.name')?.textContent?.trim());
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  let presses = 0;
  // The sidebar comes first; its entries for the admin (Storage usage, Members, #156) are on the way.
  while ((await role()) !== 'row' && presses < 25) { await page.keyboard.press('Tab'); presses++; }
  expect(await role()).toBe('row');
  // Roving tab stop sits on the first body row; header row has no tabindex.
  const first = await rowName();
  await page.keyboard.press('ArrowDown');
  const second = await rowName();
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
  await page.keyboard.press('ArrowUp');
  expect(await rowName()).toBe(first);

  // Focus the target file row, then Enter previews it. The home root is shared by every spec, so the row can be far down.
  for (let i = 0; i < 200 &&!(await rowName())?.startsWith(fileName); i++) await page.keyboard.press('ArrowDown');
  expect(await rowName()).toContain(fileName);
  await page.keyboard.press('Enter');
  const preview = page.getByRole('dialog', { name: fileName });
  await expect(preview.locator('pre')).toHaveText('kbd');
  const [download] = await Promise.all([page.waitForEvent('download'),
    preview.getByRole('link', { name: /^(Herunterladen|Download)$/ }).click()]);
  expect(download.suggestedFilename()).toBe(fileName);
});

test('a folder named like a server route survives a reload', async ({ page, baseURL }, info) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const origin = new URL(baseURL!).origin;
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin };
  const mk = await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: '/api' } });
  expect([201, 409]).toContain(mk.status()); // 409: the other project already created it
  const fileName = `inside-api-${info.project.name}.txt`;
  const up = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/api/${fileName}`)}&onCollision=replace`,
    { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from('in api') });
  expect(up.status()).toBe(201);

  await page.reload();
  await page.getByRole('button', { name: 'api', exact: true }).click();
  await expect(page).toHaveURL(/\/home\/api$/);
  await expect(page.getByRole('link', { name: fileName })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toContainText('api');
  await expect(page.getByRole('link', { name: fileName })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('"code"');
});

test('a failed login shows the error and a way to sign in again, without a redirect loop', async ({ page }) => {
  await page.goto('/auth/callback?code=bogus&state=bogus');
  await expect(page.getByRole('alert')).toContainText(/Anmeldung|sign/i);
  await expect(page.getByRole('link', { name: /Erneut anmelden|Sign in again/ })).toHaveAttribute('href', '/auth/login');
  // Once shown, the flag leaves the URL (history replace, no reload), so a reload does not repeat the alert.
  await expect(page).toHaveURL(/\/home$/);
  expect(await page.evaluate(() => location.search)).not.toContain('loginError');
  await expect(page.getByRole('alert')).toContainText(/Anmeldung|sign/i);
  // A reload is a fresh start: it signs in instead of showing the old failure.
  await page.reload();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
