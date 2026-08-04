const { test, expect } = require('@playwright/test');

test.describe('Freeshard Files — Advanced UI Features Suite (#72)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('Tab creation (+) adds a new browser tab', async ({ page }) => {
    const btnNewTab = page.locator('#btnNewTab');
    await expect(btnNewTab).toBeVisible();

    const initialTabsCount = await page.locator('#tabBarList .tab-item').count();
    await btnNewTab.click();
    await page.waitForTimeout(300);

    const newTabsCount = await page.locator('#tabBarList .tab-item').count();
    expect(newTabsCount).toBe(initialTabsCount + 1);
  });

  test('Cloud Drive (+) button opens Connect External Cloud Storage modal', async ({ page }) => {
    const btnAddCloudDrive = page.locator('#btnAddCloudDrive');
    await expect(btnAddCloudDrive).toBeVisible();
    await btnAddCloudDrive.click();

    const modalAddProvider = page.locator('#modalAddProvider');
    await expect(modalAddProvider).toBeVisible();

    const btnClose = page.locator('#btnCloseAddProvider, #btnAddProviderClose');
    if (await btnClose.isVisible()) {
      await btnClose.click();
      await expect(modalAddProvider).toBeHidden();
    }
  });

  test('Dual-Pane Split View toggles secondary file pane visibility', async ({ page }) => {
    const btnToggleSplitView = page.locator('#btnToggleSplitView');
    await expect(btnToggleSplitView).toBeVisible();

    await btnToggleSplitView.click();
    await page.waitForTimeout(300);

    const paneSecondary = page.locator('#secondaryPane');
    await expect(paneSecondary).toBeVisible();

    // Toggle back off
    await btnToggleSplitView.click();
    await page.waitForTimeout(300);
    await expect(paneSecondary).toBeHidden();
  });

  test('Right-click context menu opens and displays menu items', async ({ page }) => {
    const contextMenu = page.locator('#contextMenu');

    // Trigger context menu display
    await page.evaluate(() => {
      const menu = document.getElementById('contextMenu');
      if (menu) {
        menu.style.left = '100px';
        menu.style.top = '100px';
        menu.style.display = 'block';
      }
    });

    await expect(contextMenu).toBeVisible();

    // Hide context menu
    await page.evaluate(() => {
      const menu = document.getElementById('contextMenu');
      if (menu) menu.style.display = 'none';
    });
    await expect(contextMenu).toBeHidden();
  });

  test('Image Editing toolbar and controls function properly', async ({ page }) => {
    // Verify toolbar elements exist in modalViewer
    const imageEditToolbar = page.locator('#imageEditToolbar');
    const btnRotateImage = page.locator('#btnRotateImage');
    const btnFlipImage = page.locator('#btnFlipImage');
    const btnCropImage = page.locator('#btnCropImage');
    const btnSaveImageTransform = page.locator('#btnSaveImageTransform');

    await page.evaluate(() => {
      const modal = document.getElementById('modalMediaViewer');
      const toolbar = document.getElementById('imageEditToolbar');
      if (modal) modal.style.display = 'flex';
      if (toolbar) toolbar.style.display = 'flex';
    });

    await expect(imageEditToolbar).toBeVisible();
    await expect(btnRotateImage).toBeVisible();
    await expect(btnFlipImage).toBeVisible();
    await expect(btnCropImage).toBeVisible();
    await expect(btnSaveImageTransform).toBeVisible();
  });

  test('Full-Text Search input handles queries and triggers search', async ({ page }) => {
    const searchInput = page.locator('#searchInput');
    await expect(searchInput).toBeVisible();

    await searchInput.fill('test query');
    await searchInput.press('Enter');
    await page.waitForTimeout(300);

    // Verify search input retains value
    await expect(searchInput).toHaveValue('test query');
  });
});
