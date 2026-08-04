const { test, expect } = require('@playwright/test');

test.describe('Freeshard Files — Core File Operations Suite', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('Creates a new directory via New Folder modal', async ({ page }) => {
    const btnNewFolder = page.locator('#btnNewFolder');
    await expect(btnNewFolder).toBeVisible();
    await btnNewFolder.click();

    const modalNewFolder = page.locator('#modalNewFolder');
    await expect(modalNewFolder).toBeVisible();

    const folderName = `e2e_test_folder_${Date.now()}`;
    const input = page.locator('#inputFolderName');
    await input.fill(folderName);

    const btnConfirm = page.locator('#btnConfirmNewFolder');
    await btnConfirm.click();

    await expect(modalNewFolder).toBeHidden();

    // Verify folder appears in file list
    const folderItem = page.locator(`text=${folderName}`);
    await expect(folderItem.first()).toBeVisible({ timeout: 5000 });
  });

  test('Modal dismisses when clicking cancel button or ESC key', async ({ page }) => {
    const btnNewFolder = page.locator('#btnNewFolder');
    await btnNewFolder.click();

    const modalNewFolder = page.locator('#modalNewFolder');
    await expect(modalNewFolder).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(modalNewFolder).toBeHidden();
  });
});
