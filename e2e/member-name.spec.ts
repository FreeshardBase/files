import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';

// #337: a member whose login carries no name, username or email claim (`nameless` in the fake IdP, only `sub`) is shown
// as the localized "Mitglied", never as the internal id. Runs on the second server (E2E_FULL_PORT, globalSetup.ts), so
// the extra member stays out of the main server's member lists and pickers.
const ID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}/;

async function signedIn(browser: Browser, info: TestInfo, login: string): Promise<Page> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const ctx = await browser.newContext({ baseURL: `http://localhost:${process.env.E2E_FULL_PORT}`,
    viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
  const p = await ctx.newPage();
  await p.goto(`/auth/login?login_hint=${login}&returnTo=%2Fhome`);
  await expect(p.getByRole('navigation', { name: /Orte|Places/ })).toBeVisible();
  return p;
}

test('a member without a name claim sees “Mitglied” in the top bar, and the admin sees no id on the members page', async ({ browser }, info) => {
  const member = await signedIn(browser, info, 'nameless');
  const user = member.locator('.app-header .app-user');
  await expect(user).toHaveAttribute('title', /^(Mitglied|Member)$/);
  await expect(user.locator('.app-user-name')).toHaveText(/^(Mitglied|Member)$/);
  await expect(user.locator('.app-avatar')).toHaveText('M');
  expect(await member.locator('.app-header').textContent()).not.toMatch(ID_LIKE);
  expect(await user.getAttribute('title')).not.toMatch(ID_LIKE);
  await member.context().close();

  const admin = await signedIn(browser, info, 'testuser');
  await admin.goto('/members');
  await expect(admin.locator('.members-name > span', { hasText: /^\s*(Mitglied|Member)\s*$/ })).toHaveCount(1);
  expect(await admin.locator('tbody').textContent()).not.toMatch(ID_LIKE);
  await admin.context().close();
});
