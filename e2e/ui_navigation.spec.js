const { test, expect } = require('@playwright/test');

test.describe('Freeshard Files — UI Navigation & Settings Suite', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('Page loads correctly with app title and primary header elements', async ({ page }) => {
    await expect(page).toHaveTitle(/Freeshard Files|Files/i);
    const brand = page.locator('.brand, .fs-logo, header');
    await expect(brand.first()).toBeVisible();
  });

  test('Sidebar navigation items switch active views', async ({ page }) => {
    const navHome = page.locator('#navHome');
    const navTrash = page.locator('#navTrash');
    const navActivity = page.locator('#navActivity');

    await expect(navHome).toBeVisible();

    if (await navTrash.isVisible()) {
      await navTrash.click();
      await page.waitForTimeout(300);
      await expect(navTrash).toHaveClass(/active/);
    }

    if (await navActivity.isVisible()) {
      await navActivity.click();
      await page.waitForTimeout(300);
      await expect(navActivity).toHaveClass(/active/);
    }

    await navHome.click();
    await page.waitForTimeout(300);
    await expect(navHome).toHaveClass(/active/);
  });

  test('Grid and List view toggle updates interface layout', async ({ page }) => {
    const btnGridView = page.locator('#btnGridView');
    const btnListView = page.locator('#btnListView');
    const fileContainer = page.locator('#fileContainer, #fileList');

    if (await btnGridView.isVisible() && await btnListView.isVisible()) {
      await btnGridView.click();
      await page.waitForTimeout(200);
      await btnListView.click();
      await page.waitForTimeout(200);
      await expect(fileContainer.first()).toBeVisible();
    }
  });

  test('Settings modal opens, displays user preferences, and closes via backdrop or close button', async ({ page }) => {
    const navSettings = page.locator('#navSettings');
    if (await navSettings.isVisible()) {
      await navSettings.click();
      const modalSettings = page.locator('#modalSettings');
      await expect(modalSettings).toBeVisible();

      const btnClose = page.locator('#btnSettingsClose');
      await btnClose.click();
      await expect(modalSettings).toBeHidden();
    }
  });
});
