const { test, expect } = require('@playwright/test');

test.describe('Collapsible Navigation Sidebar & Toggle Switch Suite (#86)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Clear localStorage to start with default expanded sidebar
    await page.evaluate(() => localStorage.removeItem('sidebar_collapsed'));
    await page.reload();
    await page.waitForLoadState('networkidle');
  });

  test('clicking #btnToggleSidebar toggles .sidebar-collapsed class, aria-expanded, and sidebar width', async ({ page }) => {
    const sidebar = page.locator('.sidebar');
    const toggleBtn = page.locator('#btnToggleSidebar');

    await expect(sidebar).toBeVisible();
    await expect(toggleBtn).toBeVisible();

    // Verify initial expanded state
    await expect(sidebar).not.toHaveClass(/sidebar-collapsed/);
    await expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');

    const initialBox = await sidebar.boundingBox();
    expect(initialBox.width).toBeGreaterThanOrEqual(150);

    // Click toggle button to collapse
    await toggleBtn.click();
    await page.waitForTimeout(300); // allow CSS transition

    await expect(sidebar).toHaveClass(/sidebar-collapsed/);
    await expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');

    const collapsedBox = await sidebar.boundingBox();
    expect(collapsedBox.width).toBeLessThanOrEqual(80);

    // Click toggle button again to expand
    await toggleBtn.click();
    await page.waitForTimeout(300); // allow CSS transition

    await expect(sidebar).not.toHaveClass(/sidebar-collapsed/);
    await expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');

    const expandedBox = await sidebar.boundingBox();
    expect(expandedBox.width).toBeGreaterThanOrEqual(150);
  });

  test('pressing Control+[ keyboard shortcut toggles sidebar visibility', async ({ page }) => {
    const sidebar = page.locator('.sidebar');
    await expect(sidebar).toBeVisible();
    await expect(sidebar).not.toHaveClass(/sidebar-collapsed/);

    // Press Control+[ to collapse
    await page.keyboard.press('Control+[');
    await page.waitForTimeout(300);

    await expect(sidebar).toHaveClass(/sidebar-collapsed/);

    const collapsedBox = await sidebar.boundingBox();
    expect(collapsedBox.width).toBeLessThanOrEqual(80);

    // Press Control+[ again to expand
    await page.keyboard.press('Control+[');
    await page.waitForTimeout(300);

    await expect(sidebar).not.toHaveClass(/sidebar-collapsed/);

    const expandedBox = await sidebar.boundingBox();
    expect(expandedBox.width).toBeGreaterThanOrEqual(150);
  });

  test('sidebar collapsed preference persists in localStorage across page reloads', async ({ page }) => {
    const sidebar = page.locator('.sidebar');
    const toggleBtn = page.locator('#btnToggleSidebar');

    // Collapse sidebar
    await toggleBtn.click();
    await page.waitForTimeout(300);
    await expect(sidebar).toHaveClass(/sidebar-collapsed/);

    // Verify localStorage item set
    const storageValue = await page.evaluate(() => localStorage.getItem('sidebar_collapsed'));
    expect(storageValue).toBe('true');

    // Reload page
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Verify sidebar remains collapsed after reload
    await expect(sidebar).toHaveClass(/sidebar-collapsed/);
    const boxAfterReload = await sidebar.boundingBox();
    expect(boxAfterReload.width).toBeLessThanOrEqual(80);

    // Expand sidebar and reload
    await toggleBtn.click();
    await page.waitForTimeout(300);
    await expect(sidebar).not.toHaveClass(/sidebar-collapsed/);

    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(sidebar).not.toHaveClass(/sidebar-collapsed/);
    const boxAfterSecondReload = await sidebar.boundingBox();
    expect(boxAfterSecondReload.width).toBeGreaterThanOrEqual(150);
  });
});
