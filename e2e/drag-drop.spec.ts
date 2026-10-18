import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { places } from './places.ts';

// #338: drag & drop across sources. While our own items are dragged, a sidebar source, a breadcrumb or a folder row
// held under the pointer for 800 ms opens; a drop between sources copies (Shift moves, as a transfer job), within one
// source it moves (Ctrl/Alt copies). A badge at the pointer says what a drop will do; read-only targets refuse it.
// Desktop only: touch has no HTML5 drag and drop. Runs against the cloud server (e2e/cloudServer.ts) for Google Drive.
test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

const row = (page: Page, name: string) => page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const badge = (page: Page) => page.locator('.drag-badge');
const driveLink = (page: Page) => places(page).getByRole('link', { name: /Google Drive/ });
const skipPhone = (info: TestInfo) => test.skip(info.project.name.startsWith('mobile'), 'touch has no HTML5 drag and drop; phones use "Move to…"');

async function signedIn(page: Page) {
  await page.goto('/auth/login?returnTo=%2Fconnections');
  await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
    expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
  }
  expect((await page.request.post('/api/v1/transfers/clear', { headers })).status()).toBe(204);
  await page.reload();
  return headers;
}
async function connectDrive(page: Page): Promise<string> {
  await page.getByRole('button', { name: /Google Drive verbinden|Connect Google Drive/ }).click();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  return decodeURIComponent(new URL(page.url()).pathname.split('/')[1]!);
}
async function freshDir(page: Page, headers: Record<string, string>, source: string, dir: string, files: string[], folders: string[] = []) {
  const api = `/api/v1/sources/${encodeURIComponent(source)}`;
  await page.request.post(`${api}/delete`, { headers, data: { paths: [dir] } }); // an earlier run's
  expect((await page.request.post(`${api}/mkdir`, { headers, data: { path: dir } })).status()).toBe(201);
  for (const f of folders) expect((await page.request.post(`${api}/mkdir`, { headers, data: { path: `${dir}/${f}` } })).status()).toBe(201);
  for (const f of files) {
    const r = await page.request.put(`${api}/content?path=${encodeURIComponent(`${dir}/${f}`)}&onCollision=fail`, {
      data: Buffer.from(f), headers: { ...headers, 'content-type': 'application/octet-stream' } });
    expect(r.status(), await r.text()).toBeLessThan(300);
  }
}
const names = async (page: Page, source: string, path: string) =>
  ((await (await page.request.get(`/api/v1/sources/${encodeURIComponent(source)}/list?path=${encodeURIComponent(path)}`)).json())
    .entries as { name: string }[]).map((e) => e.name).sort();

/** Presses the mouse on `item` and starts the drag with a short move. */
async function grab(page: Page, item: Locator) {
  const b = (await item.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 8, b.y + b.height / 2 + 4);
}
async function over(page: Page, target: Locator) {
  const b = (await target.boundingBox())!;
  await page.mouse.move(b.x + Math.min(b.width / 2, 60), b.y + b.height / 2, { steps: 2 });
}

test('drag a file from the home onto the Google Drive entry, it opens, drop into a subfolder: copied', async ({ page }, info) => {
  skipPhone(info);
  const headers = await signedIn(page);
  const drive = await connectDrive(page);
  const dir = `/dnd-copy-${info.project.name}`;
  const file = `copied-${info.project.name}.txt`;
  await freshDir(page, headers, 'home', dir, [file]);
  await freshDir(page, headers, drive, `/dnd-copy-target-${info.project.name}`, []);

  await page.goto(`/home${dir}`);
  await grab(page, row(page, file).locator('td.size'));
  await over(page, driveLink(page));
  await expect(badge(page)).toHaveText(/^(Kopieren nach Google Drive|Copy to Google Drive)$/);
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/); // spring-loaded: the hover opened the Drive
  const target = row(page, `dnd-copy-target-${info.project.name}`);
  await over(page, target);
  await expect(badge(page)).toContainText(/Kopieren nach|Copy to/);
  await page.mouse.up();

  await expect.poll(() => names(page, drive, `/dnd-copy-target-${info.project.name}`)).toEqual([file]);
  expect(await names(page, 'home', dir)).toEqual([file]);
  await expect(badge(page)).toHaveCount(0);
});

test('the same drag with Shift moves: the source is gone once the job has ended', async ({ page }, info) => {
  skipPhone(info);
  const headers = await signedIn(page);
  const drive = await connectDrive(page);
  const dir = `/dnd-move-${info.project.name}`;
  const file = `moved-${info.project.name}.txt`;
  await freshDir(page, headers, 'home', dir, [file]);
  await freshDir(page, headers, drive, `/dnd-move-target-${info.project.name}`, []);

  await page.goto(`/home${dir}`);
  await grab(page, row(page, file).locator('td.size'));
  await over(page, driveLink(page));
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  await page.keyboard.down('Shift');
  await over(page, row(page, `dnd-move-target-${info.project.name}`));
  await expect(badge(page)).toHaveText(new RegExp(`^(Verschieben nach|Move to) dnd-move-target-${info.project.name}$`));
  await page.mouse.up();
  await page.keyboard.up('Shift');

  await expect.poll(() => names(page, drive, `/dnd-move-target-${info.project.name}`)).toEqual([file]);
  await expect.poll(() => names(page, 'home', dir)).toEqual([]);
});

test('within the home a drop on a folder moves, with Ctrl it copies', async ({ page }, info) => {
  skipPhone(info);
  const headers = await signedIn(page);
  const dir = `/dnd-home-${info.project.name}`;
  await freshDir(page, headers, 'home', dir, ['a.txt', 'b.txt'], ['Ziel']);
  await page.goto(`/home${dir}`);

  await grab(page, row(page, 'a.txt').locator('td.size'));
  await over(page, row(page, 'Ziel'));
  await expect(badge(page)).toHaveText(/^(Verschieben nach|Move to) Ziel$/);
  await expect(row(page, 'Ziel')).toHaveClass(/drop-target/);
  await page.mouse.up();
  await expect.poll(() => names(page, 'home', `${dir}/Ziel`)).toEqual(['a.txt']);
  await expect(row(page, 'a.txt')).toHaveCount(0);

  await grab(page, row(page, 'b.txt').locator('td.size'));
  await page.keyboard.down('Control');
  await over(page, row(page, 'Ziel'));
  await expect(badge(page)).toHaveText(/^(Kopieren nach|Copy to) Ziel$/);
  await page.mouse.up();
  await page.keyboard.up('Control');
  await expect.poll(() => names(page, 'home', `${dir}/Ziel`)).toEqual(['a.txt', 'b.txt']);
  expect(await names(page, 'home', dir)).toEqual(['Ziel', 'b.txt']);
});

test('a hover shorter than the delay does not open the source, and Esc cancels the drag', async ({ page }, info) => {
  skipPhone(info);
  const headers = await signedIn(page);
  await connectDrive(page);
  const dir = `/dnd-cancel-${info.project.name}`;
  await freshDir(page, headers, 'home', dir, ['stay.txt']);
  await page.goto(`/home${dir}`);
  const at = page.url();

  await grab(page, row(page, 'stay.txt').locator('td.size'));
  await over(page, driveLink(page));
  await expect(badge(page)).toBeVisible();
  await page.waitForTimeout(300);
  await over(page, row(page, 'stay.txt'));
  await page.waitForTimeout(1200);
  expect(page.url()).toBe(at);

  await over(page, driveLink(page));
  await expect(driveLink(page)).toHaveClass(/drop-target/);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);
  expect(page.url()).toBe(at);
  await expect(badge(page)).toHaveCount(0);
  await expect(driveLink(page)).not.toHaveClass(/drop-target/);
  await page.mouse.up();
  expect(await names(page, 'home', dir)).toEqual(['stay.txt']);
});

test('a share with read access refuses the drop visibly', async ({ page, browser }, info) => {
  skipPhone(info);
  const headers = await signedIn(page);
  const dir = `/dnd-read-${info.project.name}`;
  const file = `refused-${info.project.name}.txt`;
  await freshDir(page, headers, 'home', dir, [file]);

  // `member` shares a folder of theirs with testuser, read only.
  const ctx = await browser.newContext({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });
  const member = await ctx.newPage();
  await member.goto('/auth/login?login_hint=member&returnTo=%2F');
  await expect(places(member)).toBeVisible();
  const { csrfToken } = await (await member.request.get('/api/v1/me')).json();
  const mHeaders = { 'x-csrf-token': csrfToken, origin: new URL(member.url()).origin };
  const shared = `dnd-shared-${info.project.name}-${Date.now()}`;
  await freshDir(member, mHeaders, 'home', `/${shared}`, ['inside.txt']);
  const grantee = ((await (await member.request.get('/api/v1/members')).json()).items as { id: string; displayName: string }[])
    .find((m) => m.displayName === 'Test User')!.id;
  const made = await member.request.post('/api/v1/shares', { headers: mHeaders, data: { source: 'home', path: `/${shared}`, grantee, access: 'read' } });
  expect(made.status(), await made.text()).toBe(201);
  await ctx.close();

  await page.goto(`/home${dir}`);
  await grab(page, row(page, file).locator('td.size'));
  await over(page, places(page).getByRole('link', { name: /^(Für mich freigegeben|Shared with me)$/ }));
  await expect(page).toHaveURL(/\/shared$/);
  await over(page, row(page, shared));
  await expect(page).toHaveURL(/\/share:[0-9a-f]{32}$/);
  const source = decodeURIComponent(new URL(page.url()).pathname.split('/')[1]!);
  await expect(row(page, 'inside.txt')).toBeVisible();
  await over(page, page.locator('.folder-content'));
  await expect(badge(page)).toHaveText(/^(Hier nicht möglich|Not possible here)$/);
  await expect(badge(page)).toHaveAttribute('data-refused', 'true');
  await page.mouse.up();
  await page.waitForTimeout(500);
  expect(await names(page, source, '/')).toEqual(['inside.txt']);
  expect(await names(page, 'home', dir)).toEqual([file]);
});
