import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';

// #320: Files keeps a reserve free on the shard's disk. The admin sees the disk and the reserve on the storage page; on
// the server whose reserve is larger than any disk (E2E_FULL_PORT, globalSetup.ts) every upload is refused with the
// localized STORAGE_FULL message and the admin is warned in a banner. `testuser` is the admin, `member` is not.
const diskHeading = (page: Page) => page.getByRole('heading', { name: /^(Die Festplatte des Shards|The shard’s disk)$/ });
const diskBar = (page: Page) => page.getByRole('meter', { name: /Belegter Platz auf der Festplatte des Shards|Space used on the shard’s disk/ });

/** A second browser context signed in as `login`, with the project's device. */
async function signedIn(browser: Browser, info: TestInfo, baseURL: string, login: string): Promise<Page> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const ctx = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
  const p = await ctx.newPage();
  await p.goto(`/auth/login?login_hint=${login}&returnTo=%2Fhome`);
  await expect(p.getByRole('navigation', { name: /Orte|Places/ })).toBeVisible();
  return p;
}

test('the storage page shows the admin the shard’s disk and the default reserve; a member sees neither', async ({ page, browser, baseURL }, info) => {
  await page.goto('/storage');
  await expect(diskHeading(page)).toBeVisible();
  await expect(diskBar(page)).toBeVisible();
  await expect(page.locator('.storage-disk .storage-figures')).toContainText(/(belegt|used) · .+ (frei|free)/);
  await expect(page.locator('.storage-reserve')).toContainText(/(Für den Shard freigehalten|Kept free for the shard): .+\((die Voreinstellung|the default), 5 GiB/);

  const member = await signedIn(browser, info, baseURL!, 'member');
  await member.goto('/storage');
  await expect(member.getByRole('heading', { name: /Speicherbelegung|Storage usage/ })).toBeVisible();
  await expect(member.locator('.storage-figures').first()).toBeVisible();
  await expect(diskHeading(member)).toHaveCount(0);
  await expect(diskBar(member)).toHaveCount(0);
  await expect(member.locator('.disk-warning')).toHaveCount(0);
  await member.context().close();
});

test.describe('on a shard whose disk is down to the reserve', () => {
  test.use({ baseURL: `http://localhost:${process.env.E2E_FULL_PORT}` });

  test('an upload is refused with the localized message saying what to do, and the admin is warned', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await page.goto('/home');
    await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
    const banner = page.locator('.disk-warning');
    await expect(banner).toContainText(/Die Festplatte des Shards ist fast voll|The shard’s disk is almost full/);

    await page.getByTestId('upload-input').setInputFiles({ name: 'too-much.txt', mimeType: 'text/plain', buffer: Buffer.from('x'.repeat(1000)) });
    const summary = page.getByTestId('upload-summary');
    await expect(summary).toContainText('too-much.txt');
    await expect(summary).toContainText(
      /Leere den Papierkorb oder lösche alte Versionen|Leeren Sie den Papierkorb oder löschen Sie alte Versionen|Empty the trash or delete old versions/);
    await expect(summary).toContainText(/Admin deines Shards|Admin Ihres Shards|your shard’s admin/);
    await expect(page.getByRole('link', { name: 'too-much.txt', exact: true })).toHaveCount(0);

    await banner.getByRole('link', { name: /Zur Speicherbelegung|See storage usage/ }).click();
    await expect(diskHeading(page)).toBeVisible();
    await expect(page.locator('.storage-reserve')).toContainText('FILES_DISK_RESERVE=1000TiB');
    await expect(page.locator('.storage-disk .alert-banner')).toContainText(/fast voll|almost full/);
    expect(dialogs).toEqual([]);
  });
});
