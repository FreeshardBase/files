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

// #370: the reserve sentence sets its size and the default's figures in the mono face (#317), and writes the percentage
// the locale's way (#247): "5 %" with a no-break space in German, "5%" in English. Sets the language and resets it.
const NBSP = ' ';
for (const c of [
  { locale: 'de-du', percent: `5${NBSP}%` }, { locale: 'de-sie', percent: `5${NBSP}%` }, { locale: 'en', percent: '5%' },
] as const) {
  test(`${c.locale}: the reserve sentence sets the reserve and the default's figures in the mono face (#370)`, async ({ page }) => {
    await page.goto('/storage');
    await expect(page.locator('.storage-reserve')).toBeVisible();
    const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
    const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
    const put = async (locale: string | null) => {
      const r = await page.request.put('/api/v1/settings', { data: { locale, theme: 'system' }, headers });
      expect(r.status(), await r.text()).toBe(200);
    };
    await put(c.locale);
    try {
      await page.reload();
      const reserve = page.locator('.storage-reserve');
      await expect(reserve).toContainText(c.locale === 'en' ? 'Kept free for the shard' : 'Für den Shard freigehalten');
      expect(await reserve.evaluate((el) => getComputedStyle(el).fontFamily)).not.toContain('IBM Plex Mono');
      const figures = reserve.locator('.value-mono');
      await expect(figures).toHaveText([/^[\d.,]+\s?[kMGT]B$/, /^5\sGiB$/, /^5\s?%$/]);
      for (const f of await figures.all()) {
        expect(await f.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('IBM Plex Mono');
      }
      const text = (await reserve.textContent())!;
      expect(text).toContain(c.percent);
      expect(text).not.toContain('5 %');
      if (c.locale === 'en') expect(text).not.toContain(`5${NBSP}%`);
    } finally {
      await put(null);
    }
  });
}
