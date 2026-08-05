const { test, expect } = require('@playwright/test');

test.describe('Freeshard Files — Issue #77 Upload Engine & Multi-Source Dropdown Suite', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('Split upload dropdown menu toggles options for files, folder (webkitdirectory), and URL import', async ({ page }) => {
    const dropdownToggle = page.locator('#btnUploadDropdownToggle');
    await expect(dropdownToggle).toBeVisible();

    const dropdownMenu = page.locator('#uploadDropdownMenu');
    await expect(dropdownMenu).toBeHidden();

    await dropdownToggle.click();
    await expect(dropdownMenu).toBeVisible();

    const btnFiles = page.locator('#btnUploadFiles');
    const btnFolder = page.locator('#btnUploadFolder');
    const btnUrl = page.locator('#btnImportUrl');

    await expect(btnFiles).toBeVisible();
    await expect(btnFolder).toBeVisible();
    await expect(btnUrl).toBeVisible();

    const folderInput = page.locator('#folderInput');
    const webkitDirAttr = await folderInput.getAttribute('webkitdirectory');
    expect(webkitDirAttr).not.toBeNull();
  });

  test('Clicking Import from URL opens URL import modal and submits request', async ({ page }) => {
    const dropdownToggle = page.locator('#btnUploadDropdownToggle');
    await dropdownToggle.click();
    const dropdownMenu = page.locator('#uploadDropdownMenu');
    await expect(dropdownMenu).toBeVisible();

    const btnUrl = page.locator('#btnImportUrl');
    await btnUrl.click();

    const modalUrlImport = page.locator('#modalUrlImport');
    await expect(modalUrlImport).toBeVisible();

    const inputUrl = page.locator('#inputImportUrl');
    const inputFilename = page.locator('#inputImportFilename');
    await expect(inputUrl).toBeVisible();
    await expect(inputFilename).toBeVisible();

    await inputUrl.fill('https://example.com/test-import.pdf');
    await inputFilename.fill('imported_test_file.pdf');

    const btnSubmit = page.locator('#btnSubmitUrlImport');
    await btnSubmit.click();

    // Floating batch progress queue becomes visible
    const progressQueue = page.locator('#uploadProgressQueue');
    await expect(progressQueue).toBeVisible();
  });
});
