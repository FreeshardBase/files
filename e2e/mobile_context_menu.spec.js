const { test, expect } = require('@playwright/test');

test.describe('Mobile Context Menu & Touch Long-Press Suite (#85)', () => {
  test.use({ viewport: { width: 375, height: 667 } }); // Mobile Viewport

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app', { state: 'attached' });
    await page.waitForSelector('.file-card', { state: 'visible' });
  });

  test('verifies 3-dots (.mobile-action-dots) action menu button triggers file context menu on tap', async ({ page }) => {
    const dotsBtn = page.locator('.file-card .mobile-action-dots').first();
    await expect(dotsBtn).toBeVisible();

    await dotsBtn.click();

    const contextMenu = page.locator('#contextMenu');
    await expect(contextMenu).toBeVisible();

    // Verify context menu items are displayed
    await expect(page.locator('#ctxOpen')).toBeVisible();
    await expect(page.locator('#ctxDetails')).toBeVisible();
    await expect(page.locator('#ctxDelete')).toBeVisible();
  });

  test('verifies touch long-press (>500ms) on file card opens file context menu on mobile touch devices', async ({ page }) => {
    const fileCard = page.locator('.file-card').first();
    await expect(fileCard).toBeVisible();

    // Trigger touchstart long-press gesture (>500ms)
    await page.evaluate(async () => {
      const card = document.querySelector('.file-card');
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      const startY = rect.top + rect.height / 2;

      const touch = new Touch({
        identifier: Date.now(),
        target: card,
        clientX: startX,
        clientY: startY
      });

      const touchStartEvent = new TouchEvent('touchstart', {
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
        bubbles: true,
        cancelable: true
      });

      card.dispatchEvent(touchStartEvent);

      // Wait >500ms for long-press timer
      await new Promise(resolve => setTimeout(resolve, 550));
    });

    const contextMenu = page.locator('#contextMenu');
    await expect(contextMenu).toBeVisible();
  });

  test('verifies touch movement (>10px) cancels long-press gesture without triggering context menu', async ({ page }) => {
    const fileCard = page.locator('.file-card').first();
    await expect(fileCard).toBeVisible();

    await page.evaluate(async () => {
      const card = document.querySelector('.file-card');
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      const startY = rect.top + rect.height / 2;

      const touch1 = new Touch({
        identifier: Date.now(),
        target: card,
        clientX: startX,
        clientY: startY
      });

      const touchStartEvent = new TouchEvent('touchstart', {
        touches: [touch1],
        targetTouches: [touch1],
        changedTouches: [touch1],
        bubbles: true,
        cancelable: true
      });
      card.dispatchEvent(touchStartEvent);

      // Simulate move > 10px after 100ms
      await new Promise(resolve => setTimeout(resolve, 100));

      const touch2 = new Touch({
        identifier: Date.now(),
        target: card,
        clientX: startX + 20,
        clientY: startY + 20
      });

      const touchMoveEvent = new TouchEvent('touchmove', {
        touches: [touch2],
        targetTouches: [touch2],
        changedTouches: [touch2],
        bubbles: true,
        cancelable: true
      });
      card.dispatchEvent(touchMoveEvent);

      await new Promise(resolve => setTimeout(resolve, 500));
    });

    const contextMenu = page.locator('#contextMenu');
    await expect(contextMenu).not.toBeVisible();
  });
});
