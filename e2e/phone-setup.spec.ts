import { expect, test, type Page } from '@playwright/test';
import { openPlaces } from './places.ts';

// #321: Settings → "Use on iPhone and Android": the WebDAV address, the server, the path and the member's login as the
// user name, an app password created right there and shown once, the steps for four phone apps and the note on SMB.
// Runs as `member2`, whose login has no `preferred_username`, so the user name is the email; every password it creates
// is revoked again.
const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });

async function headersOf(page: Page) {
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
}
async function revokeAll(page: Page) {
  const headers = await headersOf(page);
  const list = await page.request.get('/api/v1/app-passwords');
  expect(list.status(), await list.text()).toBe(200);
  for (const i of (await list.json() as { items: { id: string }[] }).items) {
    const r = await page.request.delete(`/api/v1/app-passwords/${i.id}`, { headers });
    expect(r.status(), await r.text()).toBe(204);
  }
}

test('the phone page shows the address and the login, creates an app password once, and fits the phone', async ({ page }) => {
  await page.goto('/auth/login?login_hint=member2&returnTo=%2Fhome');
  await expect(page).toHaveURL(/\/home$/);
  await expect(nav(page)).toBeAttached();
  await revokeAll(page);
  await openPlaces(page);
  await nav(page).getByRole('link', { name: /Einstellungen|Settings/ }).click();
  await page.getByRole('link', { name: /Auf dem iPhone und Android nutzen|Use on iPhone and Android/ }).click();
  await expect(page).toHaveURL(/\/settings\/phone$/);
  await expect(page.getByRole('heading', { level: 1, name: /Auf dem iPhone und Android nutzen|Use on iPhone and Android/ })).toBeVisible();

  const origin = new URL(page.url());
  await expect(page.getByRole('textbox', { name: /^(WebDAV-Adresse|WebDAV address)$/ })).toHaveValue(new URL('/dav/', origin).href);
  await expect(page.getByRole('textbox', { name: /^(Server)$/ })).toHaveValue(origin.host);
  await expect(page.getByRole('textbox', { name: /^(Pfad|Path)$/ })).toHaveValue('/dav/');
  await expect(page.getByRole('textbox', { name: /^(Benutzername|User name)$/ })).toHaveValue('member2@example.com');
  for (const app of ['Documents by Readdle', 'FE File Explorer', 'Solid Explorer', 'Material Files']) {
    await expect(page.getByRole('heading', { name: app })).toBeVisible();
  }
  await expect(page.getByText(/SMB/).first()).toBeVisible();

  await page.getByRole('textbox', { name: /Gerät oder Programm|Device or program/ }).fill('Test phone');
  await page.getByRole('button', { name: /App-Passwort erstellen|Create app password/ }).click();
  const shown = page.getByRole('dialog', { name: /App-Passwort für „Test phone“|App password for “Test phone”/ });
  await expect(shown).toBeVisible();
  const field = shown.getByRole('textbox', { name: /^(App-Passwort|App password)$/ });
  await expect(field).toHaveValue(/^[a-z2-9]{40}$/);
  const password = await field.inputValue();
  // It opens WebDAV with the user name the page shows.
  const r = await page.request.fetch('/dav/', { method: 'PROPFIND', headers: { depth: '0',
    authorization: `Basic ${Buffer.from(`member2@example.com:${password}`).toString('base64')}` } });
  expect(r.status(), await r.text()).toBe(207);
  await shown.getByRole('button', { name: /^(Fertig|Done)$/ }).click();
  await expect(shown).toHaveCount(0);
  await expect(page.locator('.phone-setup .status')).toContainText(/„Test phone“|“Test phone”/);
  expect(await page.content()).not.toContain(password);
  await page.reload();
  await expect(page.getByRole('textbox', { name: /^(Benutzername|User name)$/ })).toHaveValue('member2@example.com');
  expect(await page.content()).not.toContain(password);

  // Nothing runs wider than the screen, on the phone as on the desktop.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await revokeAll(page);
});
