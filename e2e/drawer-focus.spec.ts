import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

// #381: adding a tag, removing a tag and sending a comment in the details drawer keep the focus in the drawer (the tag
// field, the next chip's remove button, the composer), so Esc still closes it. Every test works in its own folder named
// after the project; all actions run from the keyboard.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
const row = (page: Page, name: string): Locator =>
  page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });

async function openDetails(page: Page, info: TestInfo, what: string): Promise<Locator> {
  const dir = `/zz-drawer-focus-${what}-${tag(info)}`;
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: dir } })).status()).toBe(201);
  expect((await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`${dir}/plan.txt`)}&onCollision=fail`,
    { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: 'the plan' })).status()).toBe(201);
  await page.goto(`/home${dir}`);
  await row(page, 'plan.txt').getByRole('button', { name: /Aktionen für|Actions for/ }).click();
  await page.getByRole('menuitem', { name: /^Details$/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Details plan.txt', exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function closesWithEsc(page: Page, drawer: Locator) {
  await expect(page.locator('body')).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('#381 "Add tag" from the keyboard leaves the focus on the tag field and Esc closes the drawer', async ({ page }, info) => {
  const drawer = await openDetails(page, info, 'add');
  const field = drawer.locator('.tag-add input');
  await field.fill('kbd-1');
  await page.keyboard.press('Tab');
  await expect(drawer.getByRole('button', { name: /^(Tag hinzufügen|Add tag)$/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(drawer.getByRole('list', { name: /(Tags von|Tags of) plan\.txt/ }).getByRole('link')).toHaveText(['kbd-1']);
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();
  await closesWithEsc(page, drawer);
});

test('#381 removing a tag moves the focus to the next chip, then to the tag field, and Esc closes the drawer', async ({ page }, info) => {
  const drawer = await openDetails(page, info, 'remove');
  const field = drawer.locator('.tag-add input');
  const chips = drawer.getByRole('list', { name: /(Tags von|Tags of) plan\.txt/ });
  for (const name of ['kbd-1', 'kbd-2']) {
    await field.fill(name);
    await field.press('Enter');
    await expect(chips.getByRole('link', { name, exact: true })).toBeVisible();
  }
  await expect(chips.getByRole('link')).toHaveText(['kbd-1', 'kbd-2']);
  await drawer.getByRole('button', { name: /(Tag „kbd-1“ entfernen|Remove tag “kbd-1”)/ }).focus();
  await page.keyboard.press('Enter');
  await expect(chips.getByRole('link')).toHaveText(['kbd-2']);
  await expect(drawer.getByRole('button', { name: /(Tag „kbd-2“ entfernen|Remove tag “kbd-2”)/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(chips).toHaveCount(0);
  await expect(field).toBeFocused();
  await closesWithEsc(page, drawer);
});

test('#381 "Send" from the keyboard leaves the focus on the composer and Esc closes the drawer', async ({ page }, info) => {
  const drawer = await openDetails(page, info, 'send');
  await drawer.getByRole('tab', { name: /^(Kommentare|Comments)/ }).click();
  const composer = drawer.getByRole('textbox', { name: /^(Neuer Kommentar|New comment)$/ });
  await composer.fill('Looks good');
  await page.keyboard.press('Tab');
  await expect(drawer.getByRole('button', { name: /^(Senden|Send)$/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(drawer).toContainText('Looks good');
  await expect(composer).toHaveValue('');
  await expect(composer).toBeFocused();
  await closesWithEsc(page, drawer);
});
