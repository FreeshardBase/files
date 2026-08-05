const { test, expect } = require('@playwright/test');

test.describe('Issue #83: Combinatorial State Permutation Matrix Suite ({SplitView} x {ActivePane} x {TabAction})', () => {
  const splitViewOptions = [false, true];
  const activePaneOptions = ['left', 'right']; // 'left' = primary, 'right' = secondary
  const tabActions = ['switch_tab', 'create_tab', 'close_tab', 'navigate_folder'];

  splitViewOptions.forEach((splitView) => {
    activePaneOptions.forEach((activePane) => {
      tabActions.forEach((action) => {
        test(`Permutation Matrix: SplitView=${splitView} | ActivePane=${activePane} | Action=${action}`, async ({ page }) => {
          await page.goto('/');
          await page.waitForLoadState('networkidle');

          const btnSplitView = page.locator('#btnToggleSplitView');
          await expect(btnSplitView).toBeVisible();

          // 1. Set SplitView State
          if (splitView) {
            await btnSplitView.click();
            await page.waitForTimeout(300);
            await expect(page.locator('#secondaryPane')).toBeVisible();
          }

          // 2. Set ActivePane State
          if (splitView && activePane === 'right') {
            const secondaryPane = page.locator('#secondaryPane');
            await secondaryPane.click();
            await page.waitForTimeout(200);
          } else {
            const primaryPane = page.locator('#primaryPane');
            if (await primaryPane.isVisible()) {
              await primaryPane.click();
              await page.waitForTimeout(200);
            }
          }

          // 3. Execute TabAction
          const btnNewTab = page.locator('#btnNewTab');
          const tabBarList = page.locator('#tabBarList .tab-item');

          if (action === 'switch_tab') {
            await btnNewTab.click();
            await page.waitForTimeout(200);
            const initialCount = await tabBarList.count();
            expect(initialCount).toBeGreaterThanOrEqual(2);

            // Switch back to first tab
            await tabBarList.nth(0).click();
            await page.waitForTimeout(200);
            await expect(tabBarList.nth(0)).toHaveClass(/active/);
          } else if (action === 'create_tab') {
            const beforeCount = await tabBarList.count();
            await btnNewTab.click();
            await page.waitForTimeout(200);
            const afterCount = await tabBarList.count();
            expect(afterCount).toBe(beforeCount + 1);
          } else if (action === 'close_tab') {
            await btnNewTab.click();
            await page.waitForTimeout(200);
            const countBefore = await tabBarList.count();
            expect(countBefore).toBeGreaterThanOrEqual(2);

            const closeBtn = tabBarList.last().locator('.tab-close');
            await closeBtn.click();
            await page.waitForTimeout(200);
            const countAfter = await tabBarList.count();
            expect(countAfter).toBe(countBefore - 1);
          } else if (action === 'navigate_folder') {
            const breadcrumb = page.locator('.breadcrumb');
            await expect(breadcrumb.first()).toBeVisible();
          }

          // Invariant Check: Verify root app element remains stable and visible
          await expect(page.locator('#app')).toBeVisible();
        });
      });
    });
  });
});
