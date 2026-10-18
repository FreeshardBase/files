import { expect, test, type Page } from '@playwright/test';
import { openPlaces } from './places.ts';

// #157: app passwords for WebDAV in settings. Created and shown once, listed without the password, revoked; a create
// the server refuses shows its error instead of closing silently (#122). Both projects share one server and `testuser`,
// so every test removes what it created. The first test asserts the empty list, so it runs as `member2`, whom no other
// spec gives an app password, and still revokes whatever an earlier failed run of itself left (#332).
const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const settingsLink = (page: Page) => nav(page).getByRole('link', { name: /Einstellungen|Settings/ });

async function headersOf(page: Page) {
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string };
  return { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
}
/** PROPFIND on the WebDAV root as `user` with the app password; expects `status` and shows the server's answer if not. */
async function propfind(page: Page, user: string, password: string, status: number) {
  const r = await page.request.fetch('/dav/', { method: 'PROPFIND',
    headers: { depth: '0', authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } });
  expect(r.status(), `PROPFIND /dav/ answered: ${await r.text()}`).toBe(status);
}

/** Revokes every app password of the signed-in user; fails loudly if the list or a revoke is refused. */
async function revokeAll(page: Page) {
  const headers = await headersOf(page);
  const list = await page.request.get('/api/v1/app-passwords');
  expect(list.status(), await list.text()).toBe(200);
  const { items } = await list.json() as { items: { id: string }[] };
  for (const i of items) {
    const r = await page.request.delete(`/api/v1/app-passwords/${i.id}`, { headers });
    expect(r.status(), await r.text()).toBe(204);
  }
}

/**
 * Signs `page` in as `login` and waits until the redirect back has landed in the home folder. The SPA itself starts the
 * login after a 401, so a bare `goto('/home')` returns before the session exists (#332).
 */
async function signIn(page: Page, login: string) {
  await page.goto(`/auth/login?login_hint=${login}&returnTo=%2Fhome`);
  await expect(page).toHaveURL(/\/home$/);
  await expect(nav(page)).toBeAttached();
}

test('create an app password in settings, see it once, use it for WebDAV, then revoke it', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await signIn(page, 'member2');
  await revokeAll(page);
  await openPlaces(page);
  await settingsLink(page).click();
  await expect(page.getByRole('heading', { name: /^(Einstellungen|Settings)$/ })).toBeVisible();
  // How to connect: the address of the WebDAV tree on this server.
  await expect(page.getByRole('textbox', { name: /Adresse|Address/ })).toHaveValue(new URL('/dav/', page.url()).href);
  // The list has loaded (no loading line, no error) before its empty state counts.
  const appPasswords = page.locator('.app-passwords');
  await expect(appPasswords.getByText(/^(Wird geladen|Loading…)/)).toHaveCount(0);
  await expect(appPasswords.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText(/Noch keine App-Passwörter|No app passwords yet/)).toBeVisible();

  await page.getByRole('textbox', { name: /Gerät oder Programm|Device or program/ }).fill('Test laptop');
  await page.getByRole('button', { name: /App-Passwort erstellen|Create app password/ }).click();
  const shown = page.getByRole('dialog', { name: /App-Passwort für „Test laptop“|App password for “Test laptop”/ });
  await expect(shown).toBeVisible();
  const field = shown.getByRole('textbox', { name: /^(App-Passwort|App password)$/ });
  await expect(field).toHaveValue(/^[a-z2-9]{40}$/);
  const password = await field.inputValue();
  await expect(shown).toContainText(/nur jetzt|only now/);
  await propfind(page, 'member2', password, 207);

  await shown.getByRole('button', { name: /^(Fertig|Done)$/ }).click();
  await expect(shown).toHaveCount(0);
  const row = page.locator('tbody tr', { hasText: 'Test laptop' });
  await expect(row).toBeVisible();
  await expect(row).toContainText(/Zuletzt benutzt|Last used/);
  // Shown once: neither the page nor a reload carries it again.
  expect(await page.content()).not.toContain(password);
  await page.reload();
  await expect(page.locator('tbody tr', { hasText: 'Test laptop' })).toBeVisible();
  expect(await page.content()).not.toContain(password);

  // Revoking asks first; Cancel keeps it.
  await page.getByRole('button', { name: /„Test laptop“ widerrufen|Revoke “Test laptop”/ }).click();
  const confirm = page.getByRole('dialog', { name: /widerrufen\?|Revoke .*\?/ });
  await expect(confirm.getByRole('button', { name: /Abbrechen|Cancel/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await propfind(page, 'member2', password, 207);
  await page.getByRole('button', { name: /„Test laptop“ widerrufen|Revoke “Test laptop”/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^(Widerrufen|Revoke)$/ }).click();
  await expect(page.locator('tbody tr', { hasText: 'Test laptop' })).toHaveCount(0);
  await expect(page.locator('.app-passwords .status')).toContainText(/„Test laptop“ widerrufen|“Test laptop” revoked/);
  await expect(page.getByText(/Noch keine App-Passwörter|No app passwords yet/)).toBeVisible();
  await propfind(page, 'member2', password, 401);
  expect(dialogs).toEqual([]);
});

test('a create the server refuses shows its error and keeps the form (#122)', async ({ page }) => {
  await signIn(page, 'testuser');
  await revokeAll(page);
  const headers = await headersOf(page);
  // Fill up to the limit through the API, so the next create from the page is refused by the server.
  for (let i = 0; i < 20; i++) {
    const r = await page.request.post('/api/v1/app-passwords', { headers, data: { label: `Test device ${i}` } });
    expect(r.status(), await r.text()).toBe(201);
  }
  await openPlaces(page);
  await settingsLink(page).click();
  await expect(page.locator('tbody tr')).toHaveCount(20);
  const label = page.getByRole('textbox', { name: /Gerät oder Programm|Device or program/ });
  await label.fill('Test one too many');
  await page.getByRole('button', { name: /App-Passwort erstellen|Create app password/ }).click();
  await expect(page.getByRole('alert')).toContainText(/höchstens 20|at most 20/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(label).toHaveValue('Test one too many');
  await expect(page.locator('tbody tr')).toHaveCount(20);
  await revokeAll(page);
});

test('an empty label is refused in the form before anything is sent', async ({ page }) => {
  await signIn(page, 'testuser');
  await openPlaces(page);
  await settingsLink(page).click();
  let posted = false;
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/v1/app-passwords')) posted = true; });
  const label = page.getByRole('textbox', { name: /Gerät oder Programm|Device or program/ });
  await label.fill('   ');
  await page.getByRole('button', { name: /App-Passwort erstellen|Create app password/ }).click();
  await expect(label).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText(/Gib einen Namen|Geben Sie einen Namen|Enter a name/)).toBeVisible();
  expect(posted).toBe(false);
});
