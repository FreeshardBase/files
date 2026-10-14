import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const input = { mimeType: 'text/plain' };

test('log in, upload a real file, see it, download the same bytes', async ({ page }, info) => {
  const fileName = `Prüfung #1 50% ${info.project.name}.txt`;
  await page.goto('/');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();

  await page.getByTestId('upload-input').setInputFiles({ name: fileName, ...input, buffer: Buffer.from('hallo welt') });
  await expect(page.getByRole('status')).toContainText(/1 von 1|1 of 1/);
  const link = page.getByRole('link', { name: fileName });
  await expect(link).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toBe(fileName);
  expect(readFileSync(await download.path()).toString()).toBe('hallo welt');
});

test('uploading the same name twice reports the failure, not a crash', async ({ page }, info) => {
  const fileName = `dup-${info.project.name}.txt`;
  await page.goto('/');
  const files = page.getByTestId('upload-input');
  await files.setInputFiles({ name: fileName, ...input, buffer: Buffer.from('1') });
  await expect(page.getByRole('status')).toContainText(/1 von 1|1 of 1/);
  await expect(page.getByRole('link', { name: fileName })).toBeVisible();
  await files.setInputFiles({ name: fileName, ...input, buffer: Buffer.from('2') });
  await expect(page.getByRole('status')).toContainText(/0 von 1|0 of 1/);
  await expect(page.locator('.upload-failures')).toContainText(new RegExp(`${fileName}: .*(existiert bereits|already exists)`));
});

test('file list is keyboard reachable and operable', async ({ page }, info) => {
  const fileName = `kbd-${info.project.name}.txt`;
  await page.goto('/');
  const files = page.getByTestId('upload-input');
  await files.setInputFiles({ name: fileName, ...input, buffer: Buffer.from('kbd') });
  await expect(page.getByRole('link', { name: fileName })).toBeVisible();
  await files.setInputFiles({ name: `kbd2-${info.project.name}.txt`, ...input, buffer: Buffer.from('kbd') });
  await expect(page.getByRole('status')).toContainText(/1 von 1|1 of 1/);
  await expect(page.getByRole('link', { name: `kbd2-${info.project.name}.txt` })).toBeVisible();

  const role = () => page.evaluate(() => document.activeElement?.getAttribute('role'));
  const rowName = () => page.evaluate(() => document.activeElement?.querySelector('.name')?.textContent?.trim());
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  let presses = 0;
  while ((await role()) !== 'row' && presses < 15) { await page.keyboard.press('Tab'); presses++; }
  expect(await role()).toBe('row');
  // Roving tab stop sits on the first body row; header row has no tabindex.
  const first = await rowName();
  await page.keyboard.press('ArrowDown');
  const second = await rowName();
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
  await page.keyboard.press('ArrowUp');
  expect(await rowName()).toBe(first);

  // Focus the target file row, then Enter downloads it.
  for (let i = 0; i < 20 && !(await rowName())?.startsWith(fileName); i++) await page.keyboard.press('ArrowDown');
  expect(await rowName()).toContain(fileName);
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  expect(download.suggestedFilename()).toBe(fileName);
});
