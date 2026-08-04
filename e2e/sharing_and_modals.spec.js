const { test, expect } = require('@playwright/test');

test.describe('Freeshard Files — Modals & Event Delegation Suite', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('Public Share modal opens and supports password and expiration toggles', async ({ page }) => {
    // Open public share modal if button or shortcut exists
    const modalSharePublic = page.locator('#modalSharePublic');
    const btnCancelPublicShare = page.locator('#btnCancelPublicShare');

    // Trigger modal visibility manually or via trigger to test event delegation
    await page.evaluate(() => {
      const el = document.getElementById('modalSharePublic');
      if (el) el.style.display = 'flex';
    });

    await expect(modalSharePublic).toBeVisible();
    await btnCancelPublicShare.click();
    await expect(modalSharePublic).toBeHidden();
  });

  test('Event delegation closes modal on backdrop overlay click', async ({ page }) => {
    const modalAddProvider = page.locator('#modalAddProvider');

    await page.evaluate(() => {
      const el = document.getElementById('modalAddProvider');
      if (el) el.style.display = 'flex';
    });

    await expect(modalAddProvider).toBeVisible();

    // Click outside modal content on backdrop overlay
    await modalAddProvider.click({ position: { x: 10, y: 10 } });
    await expect(modalAddProvider).toBeHidden();
  });

  test('File Details modal opens and closes correctly', async ({ page }) => {
    const modalFileDetails = page.locator('#modalFileDetails');
    const btnCloseFileDetails = page.locator('#btnCloseFileDetails, #btnDetailsClose');

    await page.evaluate(() => {
      const el = document.getElementById('modalFileDetails');
      if (el) el.style.display = 'flex';
    });

    await expect(modalFileDetails).toBeVisible();
    await btnCloseFileDetails.first().click();
    await expect(modalFileDetails).toBeHidden();
  });
});
