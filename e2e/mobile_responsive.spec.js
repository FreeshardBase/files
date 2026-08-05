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

  test('verifies header flex wrap and search bar responsive scaling (<768px) (#78)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.header', { state: 'attached' });
    await page.waitForSelector('#searchInput', { state: 'attached' });

    const headerMetrics = await page.evaluate(() => {
      const header = document.querySelector('.header');
      const searchInput = document.querySelector('#searchInput');
      if (!header || !searchInput) return null;

      const headerStyle = window.getComputedStyle(header);
      const searchStyle = window.getComputedStyle(searchInput);

      return {
        flexWrap: headerStyle.flexWrap,
        headerScrollWidth: header.scrollWidth,
        headerClientWidth: header.clientWidth,
        searchWidth: searchInput.offsetWidth,
        searchMaxWidth: searchStyle.maxWidth,
        searchStyleWidth: searchStyle.width,
        hasOverflow: header.scrollWidth > header.clientWidth
      };
    });

    expect(headerMetrics).not.toBeNull();
    expect(headerMetrics.flexWrap).toBe('wrap');
    expect(headerMetrics.hasOverflow).toBe(false);
    expect(headerMetrics.headerScrollWidth).toBeLessThanOrEqual(headerMetrics.headerClientWidth);
    expect(headerMetrics.searchWidth).toBeLessThanOrEqual(headerMetrics.headerClientWidth);
  });

  test('verifies action toolbar button stacking and scroll container (<768px) (#79)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.action-buttons', { state: 'attached' });

    const toolbarMetrics = await page.evaluate(() => {
      const actionButtons = document.querySelector('.action-buttons');
      const body = document.body;
      if (!actionButtons) return null;

      const style = window.getComputedStyle(actionButtons);
      return {
        display: style.display,
        flexWrap: style.flexWrap,
        overflowX: style.overflowX,
        bodyScrollWidth: body.scrollWidth,
        bodyClientWidth: body.clientWidth,
        hasBodyOverflow: body.scrollWidth > body.clientWidth
      };
    });

    expect(toolbarMetrics).not.toBeNull();
    expect(toolbarMetrics.display).toBe('flex');
    expect(toolbarMetrics.flexWrap === 'wrap' || toolbarMetrics.overflowX === 'auto' || toolbarMetrics.overflowX === 'scroll').toBe(true);
    expect(toolbarMetrics.hasBodyOverflow).toBe(false);
    expect(toolbarMetrics.bodyScrollWidth).toBeLessThanOrEqual(toolbarMetrics.bodyClientWidth);
  });
});


test.describe('File Details Drawer — Mobile Bottom-Sheet (#80)', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('detail drawer modal content does not exceed viewport width on mobile (<768px)', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#modalFileDetails', { state: 'attached' });

    // Force the modal visible to measure it
    await page.evaluate(() => {
      const modal = document.getElementById('modalFileDetails');
      if (modal) modal.style.display = 'flex';
    });

    const metrics = await page.evaluate(() => {
      const modal = document.getElementById('modalFileDetails');
      const content = modal ? modal.querySelector('.modal-content') : null;
      if (!modal || !content) return null;
      const contentRect = content.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const modalStyle = window.getComputedStyle(modal);
      return {
        contentWidth: contentRect.width,
        viewportWidth,
        doesNotExceedViewport: contentRect.width <= viewportWidth,
        alignItems: modalStyle.alignItems
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics.doesNotExceedViewport).toBe(true);
    expect(metrics.contentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
  });

  test('detail drawer modal anchors to bottom of screen on mobile', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#modalFileDetails', { state: 'attached' });

    await page.evaluate(() => {
      const modal = document.getElementById('modalFileDetails');
      if (modal) modal.style.display = 'flex';
    });

    const isBottomAnchored = await page.evaluate(() => {
      const modal = document.getElementById('modalFileDetails');
      if (!modal) return false;
      const style = window.getComputedStyle(modal);
      const content = modal.querySelector('.modal-content');
      const contentStyle = content ? window.getComputedStyle(content) : null;
      // Either the overlay uses align-items: flex-end (bottom), or content is at bottom
      return (
        style.alignItems === 'flex-end' ||
        (contentStyle && contentStyle.borderTopLeftRadius !== '0px')
      );
    });

    expect(isBottomAnchored).toBe(true);
  });
});
