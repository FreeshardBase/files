import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { openPlaces } from './places.ts';

// #156: the storage overview and the admin's quotas. `testuser` is the admin (role from the IdP's claim), `member` is
// not. Both projects share one server; every test sets what it needs and removes the quota again at its end.
const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const storageLink = (page: Page) => nav(page).getByRole('link', { name: /Speicherbelegung|Storage usage/ });
const membersLink = (page: Page) => nav(page).getByRole('link', { name: /Mitglieder|Members/ });
const shardBar = (page: Page) => page.getByRole('meter', { name: /Belegter Speicher auf dem Shard|Storage used on the shard/ });

/** A second browser context signed in as `login`, with the project's device. */
async function signedIn(browser: Browser, info: TestInfo, baseURL: string, login: string): Promise<Page> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const ctx = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
  const p = await ctx.newPage();
  await p.goto(`/auth/login?login_hint=${login}&returnTo=%2Fhome`);
  await expect(nav(p)).toBeVisible();
  return p;
}

async function headersOf(page: Page) {
  const { csrfToken, id } = await (await page.request.get('/api/v1/me')).json() as { csrfToken: string; id: string };
  return { id, headers: { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin } };
}

test('the admin sets a quota for member on the members page; member sees it as a usage bar, and its removal', async ({ page, browser, baseURL }, info) => {
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  // A member is known to the shard once they have signed in.
  const member = await signedIn(browser, info, baseURL!, 'member');
  await openPlaces(member);
  await expect(storageLink(member)).toBeVisible();
  await expect(membersLink(member)).toHaveCount(0); // not the admin: no members page in the sidebar

  await page.goto('/home');
  await openPlaces(page);
  await membersLink(page).click();
  await expect(page.getByRole('heading', { name: /^(Mitglieder|Members)$/ })).toBeVisible();
  const row = page.locator('tbody tr', { hasText: 'member@example.com' });
  await expect(row).toBeVisible();
  const amount = row.getByRole('textbox', { name: /Kontingent für Test Member|Quota for Test Member/ });

  // Something that is not a size is refused in the form, before anything is sent.
  await amount.fill('-1');
  await row.getByRole('button', { name: /Kontingent für Test Member festlegen|Set the quota for Test Member/ }).click();
  await expect(amount).toHaveAttribute('aria-invalid', 'true');
  await expect(row).toContainText(/Gib eine Größe ab 0 ein|Geben Sie eine Größe ab 0 ein|Enter a size of 0 or more/);

  await amount.fill('50');
  await row.getByRole('combobox', { name: /Einheit für Test Member|Unit for Test Member/ }).selectOption('MB');
  await row.getByRole('button', { name: /Kontingent für Test Member festlegen|Set the quota for Test Member/ }).click();
  await expect(page.locator('.members .status')).toContainText(/50 MB/);
  await expect(row.locator('.members-quota')).toHaveText('50 MB');
  await expect(amount).not.toHaveAttribute('aria-invalid', 'true');

  // The member sees the quota as a bar on the overview.
  await openPlaces(member);
  await storageLink(member).click();
  await expect(member.getByRole('heading', { name: /Speicherbelegung|Storage usage/ })).toBeVisible();
  await expect(shardBar(member)).toBeVisible();
  await expect(shardBar(member)).toHaveAttribute('aria-valuemax', '50000000');
  await expect(member.locator('.storage-figures').first()).toContainText(/(von|of) 50 MB/);
  // The members page is the admin's: the server refuses it to the member.
  await member.goto('/members');
  await expect(member.getByRole('alert')).toContainText(/keine Berechtigung|don't have permission/);

  // Removed again: no quota, no bar.
  await row.getByRole('button', { name: /Kontingent für Test Member entfernen|Remove the quota for Test Member/ }).click();
  await expect(row.locator('.members-quota')).toHaveText(/Kein Kontingent|No quota/);
  await member.goto('/storage');
  await expect(member.locator('.storage-figures').first()).toContainText(/unbegrenzt|no quota/);
  await expect(shardBar(member)).toHaveCount(0);
  expect(dialogs).toEqual([]);
  await member.context().close();
});

test.describe('with a cloud account', () => {
  test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

  test('the overview shows a usage bar per source and the largest folders of the home', async ({ page }, info) => {
    await page.goto('/auth/login?returnTo=%2Fconnections');
    await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
    const { id, headers } = await headersOf(page);
    for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
      expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
    }
    await page.reload();
    await page.getByRole('button', { name: /Fake Cloud verbinden|Connect Fake Cloud/ }).click();
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);

    const dir = `Overview-${info.project.name}`;
    const put = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/big.bin`)}&onCollision=replace`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.alloc(3_000_000, 1) });
    expect(put.status()).toBe(201);
    expect((await page.request.put(`/api/v1/admin/members/${id}/quota`, { headers, data: { quotaBytes: 1_000_000_000 } })).status()).toBe(200);
    try {
      await openPlaces(page);
      await storageLink(page).click();
      await expect(shardBar(page)).toBeVisible();
      await expect(shardBar(page)).toHaveAttribute('aria-valuemax', '1000000000');
      const cloud = page.getByRole('meter', { name: /Fake Cloud: testuser@example\.com/ });
      await expect(cloud).toBeVisible();
      await expect(cloud).toHaveAttribute('aria-valuetext', /2[.,]5 MB (von|of) 15 GB/);
      await expect(page.locator('.storage-clouds')).toContainText(/2[.,]5 MB (von|of) 15 GB/);
      const largest = page.getByRole('table', { name: /Größte Ordner|Largest folders/ });
      await expect(largest.getByRole('link', { name: new RegExp(`/${dir}`) })).toBeVisible();
      await largest.getByRole('link', { name: new RegExp(`/${dir}`) }).click();
      await expect(page).toHaveURL(new RegExp(`/home/${dir}$`));
    } finally {
      expect((await page.request.put(`/api/v1/admin/members/${id}/quota`, { headers, data: { quotaBytes: null } })).status()).toBe(200);
      for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
        expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
      }
    }
  });

  test('a SharePoint library whose drive reports no quota shows its usage as unknown, not an error (#205)', async ({ page }) => {
    await page.goto('/auth/login?returnTo=%2Fconnections');
    await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
    const { headers } = await headersOf(page);
    const connections = async () => (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[];
    for (const c of await connections()) expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
    await page.reload();
    await page.getByRole('button', { name: /SharePoint verbinden|Connect SharePoint/ }).click();
    await page.getByRole('button', { name: 'Allow' }).click();
    const picker = page.getByRole('dialog', { name: /SharePoint-Bibliothek wählen|Choose a SharePoint library/ });
    await picker.getByRole('searchbox').fill('team');
    await picker.getByRole('button', { name: /^(Suchen|Search)$/ }).click();
    await picker.getByRole('radio', { name: /Team Site/ }).check();
    await picker.getByRole('radio', { name: 'Archive', exact: true }).check();
    await picker.getByRole('button', { name: /Bibliothek verbinden|Connect library/ }).click();
    await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
    try {
      await openPlaces(page);
      await storageLink(page).click();
      const source = page.locator('.storage-clouds li', { hasText: /SharePoint/ });
      await expect(source).toContainText(/Belegung unbekannt|Usage unknown/);
      await expect(source.locator('.storage-error')).toHaveCount(0);
      await expect(source.getByRole('meter')).toHaveCount(0);
    } finally {
      for (const c of await connections()) expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
    }
  });
});
