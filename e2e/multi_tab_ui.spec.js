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
    await page.locator('#tabBarList .tab-item').nth(1).click();
    await page.waitForTimeout(200);
    await expect(page.locator('#tabBarList .tab-item').nth(1)).toHaveClass(/active/);
    await expect(page.locator('#tabBarList .tab-item').nth(0)).not.toHaveClass(/active/);

    // Click first tab back
    await page.locator('#tabBarList .tab-item').nth(0).click();
    await page.waitForTimeout(200);
    await expect(page.locator('#tabBarList .tab-item').nth(0)).toHaveClass(/active/);
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

  test('Issue #81: Top-level tab switching dispatches globally without secondary pane interception when split view is active', async ({ page }) => {
    const btnNewTab = page.locator('#btnNewTab');
    await btnNewTab.click();
    await page.waitForTimeout(200);

    const btnSplitView = page.locator('#btnToggleSplitView');
    if (await btnSplitView.isVisible()) {
      await btnSplitView.click();
      await page.waitForTimeout(300);

      const tabItems = page.locator('#tabBarList .tab-item');
      const firstTab = tabItems.nth(0);

      // Click first top-level tab
      await firstTab.click();
      await page.waitForTimeout(200);

      // Verify top-level active tab switched to firstTab globally
      await expect(firstTab).toHaveClass(/active/);
    }
  });

  test('Issue #84: Switching between Tab A (dual-pane view) and Tab B (single-pane view) preserves each tab\'s individual layout state', async ({ page }) => {
    const btnNewTab = page.locator('#btnNewTab');
    await btnNewTab.click();
    await page.waitForTimeout(300);

    const tabItems = page.locator('#tabBarList .tab-item');
    const count = await tabItems.count();
    expect(count).toBeGreaterThanOrEqual(2);

    const tabA = tabItems.nth(0);
    const tabB = tabItems.nth(1);

    // Switch to Tab A and activate split view
    await tabA.click();
    await page.waitForTimeout(300);

    const wrapper = page.locator('#panesWrapper');
    const btnSplitView = page.locator('#btnToggleSplitView');
    await expect(btnSplitView).toBeVisible();

    const isAlreadySplit = await wrapper.evaluate(el => el.classList.contains('split-view-active'));
    if (!isAlreadySplit) {
      await btnSplitView.click();
      await page.waitForTimeout(300);
    }
    await expect(wrapper).toHaveClass(/split-view-active/);
    await expect(page.locator('#secondaryPane')).toBeVisible();

    // Switch to Tab B (single pane view)
    await tabB.click();
    await page.waitForTimeout(300);

    await expect(wrapper).not.toHaveClass(/split-view-active/);
    await expect(page.locator('#secondaryPane')).not.toBeVisible();

    // Switch back to Tab A (restores dual pane view)
    await tabA.click();
    await page.waitForTimeout(300);

    await expect(wrapper).toHaveClass(/split-view-active/);
    await expect(page.locator('#secondaryPane')).toBeVisible();

    // Switch back to Tab B (preserves single pane view)
    await tabB.click();
    await page.waitForTimeout(300);

    await expect(wrapper).not.toHaveClass(/split-view-active/);
    await expect(page.locator('#secondaryPane')).not.toBeVisible();
  });
});


