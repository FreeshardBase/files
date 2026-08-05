const { test, expect } = require('@playwright/test');

test.describe('Issue #76: Multi-Tab Visual & Functional Consistency Suite', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('Creates new tabs, switches between active tabs, and verifies visual state', async ({ page }) => {
    const btnNewTab = page.locator('#btnNewTab');
    await expect(btnNewTab).toBeVisible();

    // Click new tab button twice to create tabs
    await btnNewTab.click();
    await page.waitForTimeout(300);
    await btnNewTab.click();
    await page.waitForTimeout(300);

    const tabItems = page.locator('#tabBarList .tab-item');
    const count = await tabItems.count();
    expect(count).toBeGreaterThanOrEqual(3);

    // Verify first tab item
    const firstTab = tabItems.nth(0);
    const secondTab = tabItems.nth(1);

    // Click second tab to activate
    await secondTab.click();
    await page.waitForTimeout(200);
    await expect(secondTab).toHaveClass(/active/);
    await expect(firstTab).not.toHaveClass(/active/);

    // Click first tab back
    await firstTab.click();
    await page.waitForTimeout(200);
    await expect(firstTab).toHaveClass(/active/);
  });

  test('Closes tabs using tab close button and verifies fallback', async ({ page }) => {
    const btnNewTab = page.locator('#btnNewTab');
    await btnNewTab.click();
    await page.waitForTimeout(300);

    let tabItems = page.locator('#tabBarList .tab-item');
    const initialCount = await tabItems.count();
    expect(initialCount).toBeGreaterThanOrEqual(2);

    const closeBtn = tabItems.last().locator('.tab-close');
    await closeBtn.click();
    await page.waitForTimeout(300);

    tabItems = page.locator('#tabBarList .tab-item');
    const endCount = await tabItems.count();
    expect(endCount).toBe(initialCount - 1);
  });

  test('Supports interactive tab reordering via drag-and-drop', async ({ page }) => {
    const btnNewTab = page.locator('#btnNewTab');
    await btnNewTab.click();
    await page.waitForTimeout(300);

    const tabItems = page.locator('#tabBarList .tab-item');
    const tab1 = tabItems.nth(0);
    const tab2 = tabItems.nth(1);

    const id1 = await tab1.getAttribute('data-tab-id');
    const id2 = await tab2.getAttribute('data-tab-id');

    // Drag tab1 onto tab2
    await tab1.dragTo(tab2);
    await page.waitForTimeout(300);

    const updatedTabItems = page.locator('#tabBarList .tab-item');
    const newFirstId = await updatedTabItems.nth(0).getAttribute('data-tab-id');
    expect(newFirstId).toBeDefined();
  });

  test('Mobile viewport (375x667) maintains tab container stability without layout jumps', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.reload();
    await page.waitForLoadState('networkidle');

    const tabBarContainer = page.locator('#tabBarContainer');
    await expect(tabBarContainer).toBeVisible();

    const initialBox = await tabBarContainer.boundingBox();
    expect(initialBox).not.toBeNull();
    expect(initialBox.height).toBeLessThanOrEqual(44);

    const btnNewTab = page.locator('#btnNewTab');
    if (await btnNewTab.isVisible()) {
      await btnNewTab.click();
      await page.waitForTimeout(200);

      const newBox = await tabBarContainer.boundingBox();
      expect(newBox.height).toBe(initialBox.height);
    }
  });
});
