import { expect, test } from '@playwright/test';

// #385: up to 1200 px the members list stacks its rows and hides the column headers, so the storage-limit field has
// its own visible label and the used figure says what it is. Runs on desktop-chrome at 1000 px and on mobile-chrome.
test('stacked member rows show a visible storage-limit label for the amount field and "used" after the figure (#385)', async ({ page }, info) => {
  if (info.project.name === 'desktop-chrome') await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto('/members');
  const row = page.locator('.members-list tbody tr', { hasText: 'testuser@example.com' });
  await expect(row).toBeVisible();
  await expect(page.locator('.members-list thead')).not.toBeInViewport(); // the headers are visually hidden here

  const label = row.locator('label.fs-label', { hasText: /^(Speicherlimit|Storage limit)$/ });
  await expect(label).toBeVisible();
  const amount = row.locator('input.members-amount');
  await expect(amount).toBeVisible();
  const id = await amount.getAttribute('id');
  expect(id).toBeTruthy();
  await expect(label).toHaveAttribute('for', id!);
  // The label stands above the field, not beside it.
  const lb = (await label.boundingBox())!;
  const ab = (await amount.boundingBox())!;
  expect(lb.y + lb.height).toBeLessThanOrEqual(ab.y);
  // Clicking the label focuses the field it names.
  await label.click();
  await expect(amount).toBeFocused();

  await expect(row.locator('td.size')).toHaveText(/^\s*[\d.,]+\s\S+\s(belegt|used)\s*$/, { useInnerText: true });
});

test('wide member rows keep the column headers and show neither the field label nor the suffix (#385)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-chrome', 'wide layout only');
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto('/members');
  const row = page.locator('.members-list tbody tr', { hasText: 'testuser@example.com' });
  await expect(row).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /^(Speicherlimit|Storage limit)$/ })).toBeVisible();
  await expect(row.locator('label.fs-label')).toBeHidden();
  await expect(row.locator('td.size')).toHaveText(/^\s*[\d.,]+\s\S+\s*$/, { useInnerText: true });
});
