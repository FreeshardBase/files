import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Every glyph inside `scope` was drawn with a font the app bundles (Inter, IBM Plex Mono from @fontsource), never with a
 * font of the machine. A system font is a different font on the CI runner than on a developer's host, so a screenshot
 * baseline that contains one cannot match on both (#318). Chromium reports the fonts it used per node through CDP.
 */
export async function expectBundledFontsOnly(page: Page, scope: Locator) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await scope.evaluate((el) => el.setAttribute('data-font-probe', ''));
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-font-probe], [data-font-probe] *' });
    expect(nodeIds.length).toBeGreaterThan(0);
    const system = new Set<string>();
    let drawn = 0;
    for (const nodeId of nodeIds) {
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      for (const f of fonts) {
        drawn += f.glyphCount;
        if (!f.isCustomFont) {
          const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId });
          system.add(`${f.familyName} in ${outerHTML.slice(0, outerHTML.indexOf('>') + 1)}`);
        }
      }
    }
    expect(drawn, 'the scope has text').toBeGreaterThan(0);
    expect([...system], 'system fonts drawn').toEqual([]);
  } finally {
    await scope.evaluate((el) => el.removeAttribute('data-font-probe'));
    await cdp.detach();
  }
}
