import { expect, test } from '@playwright/test';
import { makeZip } from '../server/test/support/makeZip.ts';

// #322: a small Google Takeout archive is uploaded on the import page into a fresh folder and imported there: the Drive
// part lands as folders and files, the photo part is skipped and named in the report with the hint to use Immich.
test('import a Takeout ZIP from the import page, see the report and the imported folders', async ({ page }, info) => {
  await page.goto('/auth/login?returnTo=%2Fmigrate');
  await expect(page.getByRole('heading', { level: 1, name: /Auf den Shard umziehen|Move to the shard/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  const dir = `import-${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);

  await page.getByRole('link', { name: /Export-Archiv importieren|Import an export archive/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Export-Archiv importieren|Import an export archive/ })).toBeVisible();
  await page.getByRole('button', { name: dir, exact: true }).click();
  await expect(page.getByText(/noch kein ZIP-Archiv|No ZIP archive in this folder/)).toBeVisible();

  const zip = makeZip([
    { name: 'Takeout/Drive/Docs/notes.txt', data: 'hello notes' },
    { name: 'Takeout/Drive/top.txt', data: 'top' },
    { name: 'Takeout/Google Photos/2020/img.jpg', data: 'jpeg' },
  ]);
  await page.getByLabel(/ZIP-Archive in diesen Ordner hochladen|Upload ZIP archives into this folder/)
    .setInputFiles({ name: 'takeout-001.zip', mimeType: 'application/zip', buffer: zip });
  await expect(page.getByRole('checkbox', { name: 'takeout-001.zip' })).toBeChecked();
  await page.getByRole('button', { name: /Import starten|Start import/ }).click();

  await expect(page.getByRole('status').filter({ hasText: /Import fertig|Import finished/ })).toContainText('2');
  await expect(page.getByTestId('import-skipped')).toContainText('takeout-001.zip/Takeout/Google Photos');
  await expect(page.getByTestId('import-skipped')).toContainText(/Immich/);
  await expect(page.getByTestId('import-failed')).toHaveCount(0);

  // #354: the report outlives the page. A fresh load of another view, then back through the panel row's link to the
  // import page, which restores the member's latest import with its skipped list.
  await page.goto('/home');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeAttached();
  await page.getByTestId('transfer-panel').getByRole('listitem')
    .filter({ has: page.locator('.upload-name', { hasText: new RegExp(`/${dir}$`) }) })
    .getByRole('link', { name: /Zusammenfassung von|Summary of/ }).click();
  await expect(page).toHaveURL(/\/import$/);
  await expect(page.getByRole('status').filter({ hasText: /Import fertig|Import finished/ })).toContainText('2');
  await expect(page.getByTestId('import-skipped')).toContainText('takeout-001.zip/Takeout/Google Photos');

  await page.getByRole('link', { name: /Ordner öffnen|Open the folder/ }).click();
  const names = page.locator('tbody .name');
  await expect(names.getByText('Docs', { exact: true })).toBeVisible();
  await expect(names.getByText('top.txt', { exact: true })).toBeVisible();
  await expect(names.getByText('takeout-001.zip', { exact: true })).toBeVisible();
  await expect(names.getByText('Google Photos', { exact: true })).toHaveCount(0);
});
