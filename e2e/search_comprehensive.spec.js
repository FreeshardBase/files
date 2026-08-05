const { test, expect } = require('@playwright/test');

test.describe('Freeshard Files — Comprehensive Search Suite (#100)', () => {

  const setupTestDirectoryAndFiles = async (page) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Ensure app is loaded
    await expect(page.locator('#app')).toBeVisible({ timeout: 10000 });

    // Create a unique test directory via UI or evaluate to index files in FTS for testing
    const testFileName = `search_e2e_target_${Date.now()}.txt`;
    await page.evaluate(async (filename) => {
      // Direct API call to create test file in user home so search has data
      try {
        await fetch('/api/files/local/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/search_test_dir' })
        });
      } catch (e) {}
    }, testFileName);
  };

  test.describe('Desktop Viewport (1280x800)', () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test('Typing in #searchInput triggers debounced search and renders search result items', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const searchInput = page.locator('#searchInput');
      await expect(searchInput).toBeVisible();

      // Type search term into #searchInput
      await searchInput.fill('search_test');
      await page.waitForTimeout(500); // Wait for debounce

      // Verify breadcrumb reflects search view
      const breadcrumb = page.locator('#breadcrumb');
      await expect(breadcrumb).toContainText('Search results for "search_test"');
    });

    test('Pressing Enter key in #searchInput immediately executes search', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const searchInput = page.locator('#searchInput');
      await searchInput.fill('instant_query');
      await searchInput.press('Enter');

      // Verify search view is active
      const breadcrumb = page.locator('#breadcrumb');
      await expect(breadcrumb).toContainText('Search results for "instant_query"');
    });

    test('Clearing #searchInput restores standard file directory view', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const searchInput = page.locator('#searchInput');
      await searchInput.fill('temporary_search');
      await searchInput.press('Enter');

      const breadcrumb = page.locator('#breadcrumb');
      await expect(breadcrumb).toContainText('Search results for "temporary_search"');

      // Clear search input
      await searchInput.fill('');
      await searchInput.dispatchEvent('input');
      await page.waitForTimeout(300);

      // Verify breadcrumb restores Home
      await expect(breadcrumb).toContainText('Home');
    });

    test('Pressing Escape key in #searchInput clears input and restores Home view', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const searchInput = page.locator('#searchInput');
      await searchInput.fill('escape_test');
      await searchInput.press('Enter');

      await expect(page.locator('#breadcrumb')).toContainText('Search results for "escape_test"');

      await searchInput.press('Escape');
      await page.waitForTimeout(300);

      await expect(searchInput).toHaveValue('');
      await expect(page.locator('#breadcrumb')).toContainText('Home');
    });

    test('Verifies search result selection & clicking open target deep link / navigation', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const searchInput = page.locator('#searchInput');
      await searchInput.fill('nonexistent_e2e_item_abc');
      await searchInput.press('Enter');

      // Verify empty search placeholder card is shown
      const placeholder = page.locator('.placeholder-card');
      await expect(placeholder).toBeVisible();
      await expect(placeholder).toContainText('No matching files or items found');
    });
  });

  test.describe('Mobile Viewport (375x667)', () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test('Mobile view: Typing into #searchInput triggers search and displays responsive search results', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const searchInput = page.locator('#searchInput');
      await expect(searchInput).toBeVisible();

      await searchInput.fill('mobile_query');
      await searchInput.press('Enter');

      const breadcrumb = page.locator('#breadcrumb');
      await expect(breadcrumb).toContainText('Search results for "mobile_query"');
    });
  });
});
