import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';

const file = (name: string, text: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
const upload = (page: Page, ...files: ReturnType<typeof file>[]) => page.getByTestId('upload-input').setInputFiles(files);
const status = (page: Page) => page.getByRole('status');
// Both projects share one server and data dir; a fresh tag per test run keeps every first upload collision-free.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
/** Opens the home folder and waits until login and the redirect to /home are done. */
async function home(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
}
const dialog = (page: Page) => page.getByRole('dialog', { name: /schon vergeben|bereits vergeben|already taken/ });

async function download(page: Page, name: string): Promise<string> {
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name, exact: true }).click()]);
  return readFileSync(await d.path()).toString();
}

/** Uploads `name` with `old`, then again with `next`, and returns once the collision dialog is open. */
async function collide(page: Page, name: string, old = 'old', next = 'new') {
  await upload(page, file(name, old));
  await expect(status(page)).toContainText(/1 von 1|1 of 1/);
  await upload(page, file(name, next));
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText(name);
}
const choose = (page: Page, label: RegExp) => dialog(page).getByRole('button', { name: label }).click();
const inDialog = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));

test('the collision dialog traps focus, locks the page scroll, and Esc closes it back onto the upload button', async ({ page }, info) => {
  const name = `a11y-${tag(info)}.txt`;
  await home(page);
  // Make the page taller than the viewport so a scroll would show.
  await page.evaluate(() => { const s = document.createElement('div'); s.style.height = '4000px'; document.body.append(s); });
  await collide(page, name);
  expect(await inDialog(page)).toBe(true);
  for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); expect(await inDialog(page)).toBe(true); }
  for (let i = 0; i < 8; i++) { await page.keyboard.press('Shift+Tab'); expect(await inDialog(page)).toBe(true); }

  const vp = page.viewportSize()!;
  await page.mouse.move(vp.width / 2, vp.height / 2);
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId('upload-input')).toBeFocused();
  await expect(status(page)).toContainText(/0 von 1|0 of 1/);
  expect(await download(page, name)).toBe('old'); // Esc skips
  // Without the dialog the same wheel scrolls, so the zero above was the lock and not a page that cannot scroll.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(vp.width / 2, vp.height / 2);
  await page.mouse.wheel(0, 1500);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test('replace overwrites the existing file', async ({ page }, info) => {
  const name = `replace-${tag(info)}.txt`;
  await home(page);
  await collide(page, name);
  await choose(page, /^(Ersetzen|Replace)$/);
  await expect(status(page)).toContainText(/1 von 1|1 of 1/);
  await expect(dialog(page)).toHaveCount(0);
  expect(await download(page, name)).toBe('new');
});

test('keep both adds "name (1).ext" next to the old file', async ({ page }, info) => {
  const stem = `keep-${tag(info)}`;
  await home(page);
  await collide(page, `${stem}.txt`);
  await choose(page, /^(Beide behalten|Keep both)$/);
  await expect(status(page)).toContainText(/1 von 1|1 of 1/);
  expect(await download(page, `${stem} (1).txt`)).toBe('new');
  expect(await download(page, `${stem}.txt`)).toBe('old');
});

test('skip leaves the old content', async ({ page }, info) => {
  const name = `skip-${tag(info)}.txt`;
  await home(page);
  await collide(page, name);
  await choose(page, /^(Überspringen|Skip)$/);
  await expect(status(page)).toContainText(/0 von 1, 1 übersprungen|0 of 1 uploaded, 1 skipped/);
  await expect(page.locator('.upload-failures')).toHaveCount(0);
  expect(await download(page, name)).toBe('old');
});

test('three conflicting files with "apply to all" ask once', async ({ page }, info) => {
  const names = [1, 2, 3].map((i) => `all-${i}-${tag(info)}.txt`);
  await home(page);
  await upload(page, ...names.map((n) => file(n, 'old')));
  await expect(status(page)).toContainText(/3 von 3|3 of 3/);
  await page.evaluate(() => {
    const w = window as unknown as { dialogsOpened: number };
    w.dialogsOpened = 0;
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n instanceof HTMLElement && (n.matches('[role="dialog"]') || n.querySelector('[role="dialog"]'))) w.dialogsOpened++;
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await upload(page, ...names.map((n) => file(n, 'new')));
  await expect(dialog(page)).toContainText(names[0]!);
  await dialog(page).getByRole('checkbox', { name: /alle weiteren|all remaining/ }).check();
  await choose(page, /^(Ersetzen|Replace)$/);
  await expect(status(page)).toContainText(/3 von 3|3 of 3/);
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { dialogsOpened: number }).dialogsOpened)).toBe(1);
  for (const n of names) expect(await download(page, n)).toBe('new');
});
