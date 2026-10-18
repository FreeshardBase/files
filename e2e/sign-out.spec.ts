import { expect, test, type Page } from '@playwright/test';
import { openPlaces } from './places.ts';

// #222: "Sign out" in the header and in Settings. It ends the session on the server, clears what the browser kept for
// the member and lands on a signed-out page that never redirects to the login, so the shard's single sign-on (the fake
// IdP approves every login at once) cannot sign the member in again behind their back.
const signedOutHeading = (page: Page) => page.getByRole('heading', { level: 1, name: /^(Abgemeldet|Signed out)$/ });

async function signIn(page: Page) {
  await page.goto('/home');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeVisible();
  // What the browser keeps for the member: a cached preference and a waiting share in the share inbox.
  await page.evaluate(async () => {
    localStorage.setItem('files.view', 'gallery');
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('files-share-inbox', 1);
      open.onupgradeneeded = () => { open.result.createObjectStore('shares', { keyPath: 'id' }); };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('shares', 'readwrite');
        tx.objectStore('shares').put({ id: 'pending', created: Date.now(), files: [] });
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
}

async function expectSignedOut(page: Page) {
  await expect(signedOutHeading(page)).toBeVisible();
  await expect(page).toHaveURL(/\/signed-out$/);
  // The app's brand mark (#314): the 22 px line folder glyph in front of the name, as in the signed-in header.
  const glyph = page.locator('.app-header .app-title .icon-folder.app-logo');
  await expect(glyph).toBeVisible();
  expect((await glyph.boundingBox())?.width).toBe(22);
  expect((await page.request.get('/api/v1/me')).status()).toBe(401);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  const inbox = await page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open('files-share-inbox', 1);
    open.onupgradeneeded = () => { open.result.createObjectStore('shares', { keyPath: 'id' }); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = open.result.transaction('shares', 'readonly').objectStore('shares').count();
      req.onsuccess = () => { open.result.close(); resolve(req.result); };
      req.onerror = () => reject(req.error);
    };
  }));
  expect(inbox).toBe(0);
  // A reload stays signed out: no silent single sign-on.
  await page.reload();
  await expect(signedOutHeading(page)).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/signed-out$/);
  expect((await page.request.get('/api/v1/me')).status()).toBe(401);
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toHaveCount(0);
}

test('the header signs out: the session ends, the browser forgets the member and no silent sign-in follows', async ({ page }) => {
  await signIn(page);
  await page.getByRole('banner').getByRole('button', { name: /^(Abmelden|Sign out)$/ }).click();
  await expectSignedOut(page);
  // Signing in again is the member's own choice.
  await page.getByRole('link', { name: /^(Anmelden|Sign in)$/ }).click();
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeVisible();
  expect((await page.request.get('/api/v1/me')).status()).toBe(200);
});

test('Settings signs out as well', async ({ page }) => {
  await signIn(page);
  const nav = await openPlaces(page);
  await nav.getByRole('link', { name: /^(Einstellungen|Settings)$/ }).click();
  await page.getByRole('main').getByRole('button', { name: /^(Abmelden|Sign out)$/ }).click();
  await expectSignedOut(page);
});
