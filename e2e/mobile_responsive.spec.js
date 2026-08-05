const { test, expect } = require('@playwright/test');

test.describe('Mobile Viewport & Overflow Tests (#75)', () => {
  test.use({ viewport: { width: 375, height: 667 } }); // 375x667 Mobile Viewport

  test('verifies zero horizontal body overflow on mobile (375x667)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app', { state: 'attached' });
    
    const overflowInfo = await page.evaluate(() => {
      const docEl = document.documentElement;
      const body = document.body;
      return {
        clientWidth: docEl.clientWidth,
        scrollWidth: docEl.scrollWidth,
        bodyScrollWidth: body.scrollWidth,
        bodyClientWidth: body.clientWidth,
        hasHorizontalScrollbar: docEl.scrollWidth > docEl.clientWidth
      };
    });

    expect(overflowInfo.hasHorizontalScrollbar).toBe(false);
    expect(overflowInfo.scrollWidth).toBeLessThanOrEqual(overflowInfo.clientWidth);
    expect(overflowInfo.bodyScrollWidth).toBeLessThanOrEqual(overflowInfo.clientWidth);
  });

  test('verifies mobile toolbar and breadcrumbs responsiveness', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.toolbar-area', { state: 'attached' });

    const toolbarStyle = await page.evaluate(() => {
      const toolbar = document.querySelector('.toolbar-area');
      if (!toolbar) return null;
      const style = window.getComputedStyle(toolbar);
      return {
        display: style.display,
        flexDirection: style.flexDirection,
        flexWrap: style.flexWrap
      };
    });

    expect(toolbarStyle).not.toBeNull();
    expect(toolbarStyle.flexDirection === 'column' || toolbarStyle.flexWrap === 'wrap').toBe(true);
  });
});
