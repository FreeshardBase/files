const { test, expect } = require('@playwright/test');

test.describe('Issue #74: Provider Authentication Flow Audit & UI Mapping (OAuth vs Credentials)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('Opens modalAddProvider and verifies clear visual separation between OAuth 2.0 and Credential forms', async ({ page }) => {
    const btnAddCloud = page.locator('#btnAddCloudDrive');
    await expect(btnAddCloud).toBeVisible();
    await btnAddCloud.click();

    const modal = page.locator('#modalAddProvider');
    await expect(modal).toBeVisible();

    // Verify OAuth 2.0 section and 1-click links
    const oauthSection = modal.locator('.provider-auth-section[data-flow="oauth2"]');
    await expect(oauthSection).toBeVisible();
    await expect(oauthSection.locator('a[data-provider="gdrive"]')).toBeVisible();
    await expect(oauthSection.locator('a[data-provider="dropbox"]')).toBeVisible();
    await expect(oauthSection.locator('a[data-provider="onedrive"]')).toBeVisible();
    await expect(oauthSection.locator('a[data-provider="sharepoint"]')).toBeVisible();

    // Verify Credential section and form inputs
    const credSection = modal.locator('.provider-auth-section[data-flow="credentials"]');
    await expect(credSection).toBeVisible();
    await expect(credSection.locator('#formAddS3Provider')).toBeVisible();
    await expect(credSection.locator('#formAddMoveitProvider')).toBeVisible();
    await expect(credSection.locator('#formAddOneDriveProvider')).toBeVisible();
    await expect(credSection.locator('#formAddSharePointProvider')).toBeVisible();

    // Close modal
    const btnCancel = modal.locator('#btnCancelAddProvider');
    await btnCancel.scrollIntoViewIfNeeded();
    await btnCancel.click();
    await expect(modal).toBeHidden();
  });
});
