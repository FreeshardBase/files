import { expect, test, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openPlaces } from './places.ts';

// #146: internal shares. `testuser` owns and shares, `member` receives, `member2` is a third member for the picker.
// Both projects share one server; every test works in its own folder named after the project and test.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const crumbs = (page: Page) => page.getByRole('navigation', { name: /Pfad|Path/ });
const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const shareDialog = (page: Page) => page.getByRole('dialog', { name: /freigeben|Share/ });
const menuButton = (page: Page, name: string) =>
  row(page, name).getByRole('button', { name: new RegExp(`(Aktionen für|Actions for) ${name.replace(/[.()]/g, '\\$&')}`) });

/** A second browser context signed in as `login`, with the project's device. */
async function signedIn(browser: Browser, info: TestInfo, baseURL: string, login: string, returnTo = '/'): Promise<Page> {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const ctx = await browser.newContext({ baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
  const p = await ctx.newPage();
  await p.goto(`/auth/login?login_hint=${login}&returnTo=${encodeURIComponent(returnTo)}`);
  await expect(nav(p)).toBeVisible();
  return p;
}

/** Creates `<dir>` with files through the API as the page's user, then opens the folder that holds it in the SPA. `<dir>`
 *  sits in a parent of its own: the shared home root grows past 200 entries over a run, and the phone's window over such a
 *  list (#225) renders only the rows near the top. */
async function setup(page: Page, dir: string, files: Record<string, string>) {
  await page.goto('/');
  await expect(crumbs(page)).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  const parent = `/zz-shares-${dir}`;
  for (const path of [parent, `${parent}/${dir}`]) {
    expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path } })).status()).toBe(201);
  }
  for (const [name, text] of Object.entries(files)) {
    const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`${parent}/${dir}/${name}`)}&onCollision=fail`,
      { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from(text) });
    expect(r.status()).toBe(201);
  }
  await page.goto(`/home${parent}`);
  await expect(row(page, dir)).toBeVisible();
}

test('owner shares a folder read-only; the member opens it under "Shared with me" and downloads a file, upload is not offered', async ({ page, browser, baseURL }, info) => {
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  // A member is known to the shard once they have signed in.
  const member = await signedIn(browser, info, baseURL!, 'member', '/shared');
  const dir = `share-read-${tag(info)}`;
  await setup(page, dir, { 'plan.txt': 'shared bytes' });

  await menuButton(page, dir).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /^(Freigeben|Share)$/ }).click();
  const d = shareDialog(page);
  await expect(d).toBeVisible();
  await d.getByRole('combobox', { name: /Mitglied|Member/ }).fill('Test Mem');
  await d.getByRole('option', { name: 'Test Member' }).click();
  await expect(d.getByRole('radio', { name: /ansehen|view/ })).toBeChecked(); // read is the default
  await d.getByRole('button', { name: /^(Freigeben|Share)$/ }).click();
  await expect(d.getByRole('list', { name: /Wer hat Zugriff|Who has access/ })).toContainText('Test Member');
  await expect(d.getByRole('list', { name: /Wer hat Zugriff|Who has access/ })).toContainText(/Darf ansehen|Can view/);
  await page.keyboard.press('Escape');
  await expect(d).toHaveCount(0);

  await member.reload();
  await openPlaces(member);
  await nav(member).getByRole('link', { name: /Für mich freigegeben|Shared with me/ }).click();
  await expect(member).toHaveURL(/\/shared$/);
  const shared = member.locator('tbody tr', { has: member.getByText(dir, { exact: true }) });
  await expect(shared).toContainText('Test User');
  await expect(shared).toContainText(/Darf ansehen|Can view/);
  await shared.getByRole('link', { name: new RegExp(`(${dir} öffnen|Open ${dir})`) }).click();
  await expect(member).toHaveURL(/\/share:[0-9a-f]{32}$/);
  await expect(crumbs(member)).toContainText(dir);
  await expect(row(member, 'plan.txt')).toBeVisible();
  // Read only: no upload, no rename, move or trash anywhere.
  await expect(member.getByTestId('upload-input')).toHaveCount(0);
  await expect(member.getByRole('button', { name: /Hochladen|Upload/ })).toHaveCount(0);
  await menuButton(member, 'plan.txt').click();
  await expect(member.getByRole('menu').getByRole('menuitem')).toHaveText([/Herunterladen|Download/, 'Details',
    /Kopieren nach|Copy to…/, /Zu Favoriten hinzufügen|Add to favourites/]);
  const [download] = await Promise.all([member.waitForEvent('download'),
    member.getByRole('menu').getByRole('menuitem', { name: /Herunterladen|Download/ }).click()]);
  expect(download.suggestedFilename()).toBe('plan.txt');
  expect(readFileSync(await download.path()).toString()).toBe('shared bytes');
  expect(dialogs).toEqual([]);
  await member.context().close();
});

test('the share dialog works with the keyboard alone, and the member picker filters by name', async ({ page, browser, baseURL }, info) => {
  // The picker offers members the shard knows, i.e. who has signed in once.
  for (const login of ['member', 'member2']) await (await signedIn(browser, info, baseURL!, login)).context().close();
  const dir = `share-keys-${tag(info)}`;
  await setup(page, dir, { 'a.txt': 'a' });
  await row(page, dir).focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu')).toBeVisible();
  for (let i = 0; i < 6 && !(await page.getByRole('menuitem', { name: /^(Freigeben|Share)$/ }).evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('ArrowDown');
  }
  await page.keyboard.press('Enter');
  const d = shareDialog(page);
  const picker = d.getByRole('combobox', { name: /Mitglied|Member/ });
  await expect(picker).toBeFocused();

  // Filtering: only names containing the typed text, ignoring case.
  await page.keyboard.type('second');
  await expect(d.getByRole('option')).toHaveText(['Second Member']);
  await page.keyboard.press('Control+A');
  await page.keyboard.type('zzz');
  await expect(d.getByRole('option')).toHaveCount(0);
  await expect(d).toContainText(/Kein Mitglied passt zu|No member matches/);
  await page.keyboard.press('Control+A');
  await page.keyboard.type('MEM');
  await expect(d.getByRole('option')).toHaveText(['Second Member', 'Test Member']);
  // Arrow keys move the active option; Enter picks it; Esc in the open list closes only the list.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(picker).toHaveAttribute('aria-activedescendant', /.+/);
  await page.keyboard.press('Enter');
  await expect(picker).toHaveValue('Test Member');
  await expect(d.getByRole('option')).toHaveCount(0);

  // Tab to the access radios, arrow to "edit", Tab to Share, Enter.
  await page.keyboard.press('Tab');
  await expect(d.getByRole('radio', { name: /ansehen|view/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(d.getByRole('radio', { name: /bearbeiten|edit/ })).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(d.getByRole('button', { name: /^(Freigeben|Share)$/ })).toBeFocused();
  await page.keyboard.press('Enter');
  const who = d.getByRole('list', { name: /Wer hat Zugriff|Who has access/ });
  await expect(who).toContainText('Test Member');
  await expect(who).toContainText(/Darf bearbeiten|Can edit/);

  // Revoke with the keyboard: Tab reaches "Remove access", Enter removes it.
  const remove = d.getByRole('button', { name: /(Zugriff für Test Member entfernen|Remove access for Test Member)/ });
  for (let i = 0; i < 6 && !(await remove.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(remove).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(who).toHaveCount(0);
  await expect(d).toContainText(/Nur du|Nur Sie|Only you/);
  await expect(picker).toBeFocused(); // the removed row's button is gone; the focus stays in the dialog

  // Share again (read), then Esc closes the dialog and the focus goes back to the row.
  await page.keyboard.type('test');
  await page.keyboard.press('Enter');
  await d.getByRole('button', { name: /^(Freigeben|Share)$/ }).focus();
  await page.keyboard.press('Enter');
  await expect(who).toContainText('Test Member');
  await page.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
  await expect(row(page, dir)).toBeFocused();

  // The details drawer lists who has access.
  await page.keyboard.press('Shift+F10');
  for (let i = 0; i < 8 && !(await page.getByRole('menuitem', { name: /^Details$/ }).evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('ArrowDown');
  }
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: `Details ${dir}`, exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('list', { name: /Wer hat Zugriff|Who has access/ })).toContainText(/Test Member.*(Darf ansehen|Can view)/);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
});

/** Opens the share dialog of `name` through the row's menu with the mouse. */
async function openShare(page: Page, name: string) {
  await menuButton(page, name).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /^(Freigeben|Share)$/ }).click();
  const d = shareDialog(page);
  await expect(d).toBeVisible();
  return d;
}

test('#223: clicks land while the member list is open; the list overlays the form and never moves it', async ({ page, browser, baseURL }, info) => {
  for (const login of ['member', 'member2']) await (await signedIn(browser, info, baseURL!, login)).context().close();
  const dir = `share-click-${tag(info)}`;
  await setup(page, dir, { 'a.txt': 'a' });
  const d = await openShare(page, dir);
  const picker = d.getByRole('combobox', { name: /Mitglied|Member/ });
  const edit = d.getByRole('radio', { name: /bearbeiten|edit/ });
  const submit = d.getByRole('button', { name: /^(Freigeben|Share)$/ });

  // The open list does not push the access radios or "Share" down.
  await picker.click();
  await page.keyboard.type('Test Mem');
  await expect(d.getByRole('option', { name: 'Test Member' })).toBeVisible();
  const open = await submit.boundingBox();
  await page.keyboard.press('Escape');
  await expect(d.getByRole('option')).toHaveCount(0);
  expect(await submit.boundingBox()).toEqual(open);

  // The full name typed, then the mouse: "Can edit" takes the click and "Share" sends the share.
  await picker.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Test Member');
  await edit.click();
  await expect(edit).toBeChecked();
  await submit.click();
  const who = d.getByRole('list', { name: /Wer hat Zugriff|Who has access/ });
  await expect(who).toContainText('Test Member');
  await expect(who).toContainText(/Darf bearbeiten|Can edit/);
});

test('#223: the member picker lists the members on focus; an unknown name keeps its inline note', async ({ page, browser, baseURL }, info) => {
  for (const login of ['member', 'member2']) await (await signedIn(browser, info, baseURL!, login)).context().close();
  const dir = `share-focus-${tag(info)}`;
  await setup(page, dir, { 'a.txt': 'a' });
  const d = await openShare(page, dir);
  const picker = d.getByRole('combobox', { name: /Mitglied|Member/ });
  await expect(picker).toBeFocused();
  // Nothing typed yet: every member is offered.
  await expect(d.getByRole('option', { name: 'Test Member' })).toBeVisible();
  await expect(d.getByRole('option', { name: 'Second Member' })).toBeVisible();
  await expect(picker).toHaveAttribute('aria-expanded', 'true');
  await d.getByRole('option', { name: 'Second Member' }).click();
  await expect(picker).toHaveValue('Second Member');
  await expect(d.getByRole('option')).toHaveCount(0);

  // An unknown name: the note stays when the field loses the focus, and "Share" says to choose from the list.
  await picker.fill('');
  await picker.pressSequentially('Nobody Here');
  await expect(d).toContainText(/Kein Mitglied passt zu „Nobody Here“|No member matches “Nobody Here”/);
  await d.getByRole('radio', { name: /ansehen|view/ }).click();
  await expect(d).toContainText(/Kein Mitglied passt zu „Nobody Here“|No member matches “Nobody Here”/);
  await d.getByRole('button', { name: /^(Freigeben|Share)$/ }).click();
  await expect(d.getByRole('alert')).toHaveText(/Wähle ein Mitglied|Wählen Sie ein Mitglied|Choose a member/);
  await expect(d).toContainText(/Nur du|Nur Sie|Only you/);
});

test('#235: a share revoked while the member has it open says so and leads back to "Shared with me"', async ({ page, browser, baseURL }, info) => {
  const member = await signedIn(browser, info, baseURL!, 'member', '/shared');
  const dir = `share-revoked-${tag(info)}`;
  await setup(page, dir, { 'plan.txt': 'shared bytes' });
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  const grantee = ((await (await page.request.get('/api/v1/members')).json()).items as { id: string; displayName: string }[])
    .find((m) => m.displayName === 'Test Member')!.id;
  const made = await page.request.post('/api/v1/shares', { headers, data: { source: 'home', path: `/zz-shares-${dir}/${dir}`, grantee, access: 'read' } });
  expect(made.status(), await made.text()).toBe(201);

  await member.reload();
  await member.locator('tbody tr', { has: member.getByText(dir, { exact: true }) })
    .getByRole('link', { name: new RegExp(`(${dir} öffnen|Open ${dir})`) }).click();
  await expect(row(member, 'plan.txt')).toBeVisible();
  const at = member.url();

  expect((await page.request.delete(`/api/v1/shares/${(await made.json()).id as string}`, { headers })).status()).toBe(204);
  await member.goto(at);
  const alert = member.getByRole('alert');
  await expect(alert.getByRole('heading', { name: /Freigabe nicht mehr verfügbar|Share no longer available/ })).toBeVisible();
  await expect(alert).toContainText(/hat die Freigabe beendet|has ended the share/);
  // No dead end: no path, no view switches of a folder that is not there, and one way on.
  await expect(crumbs(member)).toHaveCount(0);
  await expect(member.getByRole('button', { name: /^(Liste|List)$/ })).toHaveCount(0);
  await alert.getByRole('link', { name: /Zu „Für mich freigegeben“|Go to “Shared with me”/ }).click();
  await expect(member).toHaveURL(/\/shared$/);
  await expect(member.getByRole('heading', { name: /Für mich freigegeben|Shared with me/ })).toBeVisible();
  await expect(member.getByText(dir, { exact: true })).toHaveCount(0);
  await member.context().close();
});

test('#407: the share dialog says "Only you." only without members and without an active public link', async ({ page }, info) => {
  const dir = `share-links-${tag(info)}`;
  await setup(page, dir, { 'a.txt': 'a' });
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  const path = `/zz-shares-${dir}/${dir}`;
  const onlyYou = /Nur du\.|Nur Sie\.|Only you\./;
  const linksOnly = /Keine Mitglieder\. Wer einen der öffentlichen Links unten hat, kann es öffnen\.|No members\. Anyone with a public link below can open it\./;

  // A link whose downloads are used up opens nothing, so it does not count.
  const used = await page.request.post('/api/v1/links', { headers,
    data: { source: 'home', path, label: 'Used up', expiresAt: null, maxDownloads: 0, password: null } });
  expect(used.status()).toBeLessThan(300);
  let d = await openShare(page, dir);
  await expect(d).toContainText('Used up');
  await expect(d).toContainText(onlyYou);
  await expect(d).not.toContainText(linksOnly);
  // The member picker has the focus and its list open, so Esc would close only the list.
  await d.getByRole('button', { name: /^(Schließen|Close)$/ }).click();
  await expect(d).toHaveCount(0);

  const created = await page.request.post('/api/v1/links', { headers,
    data: { source: 'home', path, label: 'For the printer', expiresAt: null, maxDownloads: null, password: null } });
  expect(created.status()).toBeLessThan(300);
  d = await openShare(page, dir);
  await expect(d).toContainText('For the printer');
  await expect(d).toContainText(linksOnly);
  await expect(d).not.toContainText(onlyYou);

  // Revoking the link in the dialog brings "Only you." back.
  const revoke = d.getByRole('button', { name: /(For the printer widerrufen|Revoke For the printer)/ });
  await revoke.click();
  await page.getByRole('dialog', { name: /For the printer/ }).getByRole('button', { name: /^(Widerrufen|Revoke)$/ }).click();
  await expect(revoke).toHaveCount(0);
  await expect(d).toContainText(onlyYou);
  await expect(d).not.toContainText(linksOnly);
});
