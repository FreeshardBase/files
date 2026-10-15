import { expect, type Locator, type Page } from '@playwright/test';

/** The sidebar of places (`<nav>` "Places"). */
export const places = (page: Page): Locator => page.getByRole('navigation', { name: /Orte|Places/ });

/**
 * Shows the places. On a phone they collapse behind the "Places" toggle (#160) and close again after each navigation;
 * on a wide screen the toggle is hidden and this does nothing.
 */
export async function openPlaces(page: Page): Promise<Locator> {
  const nav = places(page);
  await expect(nav).toBeVisible();
  const toggle = nav.getByRole('button', { name: /^(Orte|Places)$/ });
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
  return nav;
}
