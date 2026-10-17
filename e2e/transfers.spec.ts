import { expect, test, type Page } from '@playwright/test';
import { openPlaces } from './places.ts';

// #152 (regression for #115: paste was hardcoded to the local source): a file copied in a cloud connection is pasted into
// the home. The paste becomes a transfer job, the transfer panel shows it until it is done, and the copy opens. Runs
// against the cloud server (e2e/cloudServer.ts), whose generic fake cloud holds /report.txt ("quarterly numbers").
test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });
const row = (page: Page, name: string) => page.locator('tbody tr', { has: page.locator('.name').getByText(name, { exact: true }) });
const panel = (page: Page) => page.getByRole('region', { name: /^(Übertragungen|Transfers)$/ });

/** Signs in as testuser, removes connections and finished transfers an earlier test or project left (one shared server). */
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

test('copy a file from a cloud connection, paste it into the home, watch the transfer and open the copy', async ({ page }, info) => {
  const headers = await signedIn(page);
  const dir = `transfer-${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);

  await page.getByRole('button', { name: /Fake Cloud verbinden|Connect Fake Cloud/ }).click();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  await row(page, 'report.txt').getByRole('button', { name: /(Aktionen für|Actions for) report\.txt/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: /^(Kopieren|Copy)$/ }).click();
  await expect(page.getByRole('status')).toContainText(/Ein Element zum Kopieren vorgemerkt|One item ready to copy/);

  // Into another source: the home, in this project's own folder.
  await openPlaces(page);
  await nav(page).getByRole('link', { name: /Mein Speicher|My storage/ }).click();
  await page.getByRole('button', { name: dir, exact: true }).click();
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toContainText(dir);
  await page.getByRole('button', { name: /Hierher kopieren \(1\)|Copy here \(1\)/ }).click();
  await expect(page.getByRole('status')).toContainText(/Ein Element wird kopiert|Copying one item/);

  await expect(panel(page)).toContainText(/„report\.txt“ nach Mein Speicher\/transfer-|Copy “report\.txt” to My storage\/transfer-/);
  await expect(panel(page).getByRole('progressbar', { name: /report\.txt/ })).toHaveAttribute('aria-valuenow', '100');
  await expect(panel(page)).toContainText(/Fertig|Done/);
  // The folder relists once the job has ended; the copy opens like any file of the home.
  await expect(row(page, 'report.txt')).toBeVisible();
  await page.getByRole('link', { name: 'report.txt', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'report.txt', exact: true });
  await expect(preview).toContainText('quarterly numbers');
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);

  // The done job leaves the panel by itself once it has been seen (#234).
  await expect(panel(page)).toHaveCount(0, { timeout: 15_000 });
});

/** Connects the Fake Cloud through its consent page; answers the connection's source. */
async function connectFake(page: Page): Promise<string> {
  await page.getByRole('button', { name: /Fake Cloud verbinden|Connect Fake Cloud/ }).click();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  return decodeURIComponent(new URL(page.url()).pathname.slice(1));
}
type Job = { id: string; status: string };
async function settledJob(page: Page, id: string): Promise<Job> {
  let job: Job | undefined;
  await expect.poll(async () => (job = await (await page.request.get(`/api/v1/transfers/${id}`)).json() as Job).status,
    { timeout: 15_000 }).not.toBe('running');
  return job!;
}
const listedJobs = async (page: Page) => ((await (await page.request.get('/api/v1/transfers')).json()).items as Job[]).map((j) => j.id);

test('#234: a job of two items is labelled by its count with the names in its details, and leaves once seen', async ({ page }, info) => {
  const headers = await signedIn(page);
  const dir = `transfer-many-${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  const from = await connectFake(page);
  const r = await page.request.post('/api/v1/transfers', { headers, data: { mode: 'copy', from, to: 'home', dir: `/${dir}`,
    items: [{ path: '/report.txt', onCollision: 'fail' }, { path: '/Notes', onCollision: 'fail' }] } });
  expect(r.status(), await r.text()).toBe(201);
  const job = await settledJob(page, (await r.json() as Job).id);
  expect(job.status).toBe('completed');

  // The panel's timers run on the test's clock, so "a few seconds" is exact.
  await page.clock.install();
  await page.goto(`/home/${dir}`);
  await expect(panel(page)).toContainText(new RegExp(`^.*(2 Elemente nach Mein Speicher/${dir} kopieren|Copy 2 items to My storage/${dir})`));
  await expect(panel(page)).not.toContainText(/„report\.txt“|“report\.txt”/);
  await panel(page).getByText(/^(Namen anzeigen|Show names)$/).click();
  await expect(panel(page).getByRole('listitem').filter({ hasText: /^report\.txt$/ })).toBeVisible();
  await expect(panel(page).getByRole('listitem').filter({ hasText: /^Notes$/ })).toBeVisible();
  await expect(panel(page).getByRole('progressbar', { name: /(Fortschritt von|Progress of) (2 Elemente|2 items)/ })).toBeVisible();

  // Still there just before the few seconds are up; gone after them, on the server too, so a new page does not show it.
  await page.clock.runFor(4000);
  await expect(panel(page)).toBeVisible();
  await page.clock.runFor(1500);
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => listedJobs(page)).not.toContain(job.id);
  await page.reload();
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toContainText(dir);
  await expect(panel(page)).toHaveCount(0);
});

test('#234: a failed job folds into one summary line after a few seconds and stays until it is removed', async ({ page }, info) => {
  const headers = await signedIn(page);
  const dir = `transfer-failed-${info.project.name}-${info.repeatEachIndex}-${info.retry}`;
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  // The name is taken in the target and the job was told to fail on a collision.
  expect((await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(`/${dir}/report.txt`)}&onCollision=fail`,
    { headers: { ...headers, 'content-type': 'application/octet-stream' }, data: Buffer.from('mine') })).status()).toBe(201);
  const from = await connectFake(page);
  const r = await page.request.post('/api/v1/transfers', { headers, data: { mode: 'copy', from, to: 'home', dir: `/${dir}`,
    items: [{ path: '/report.txt', onCollision: 'fail' }] } });
  expect(r.status(), await r.text()).toBe(201);
  const job = await settledJob(page, (await r.json() as Job).id);
  expect(job.status).toBe('completed_with_errors');

  await page.clock.install();
  await page.goto(`/home/${dir}`);
  const failure = panel(page).getByText(/^\/report\.txt: /);
  await expect(failure).toBeVisible();
  const full = (await panel(page).boundingBox())!.height;
  await page.clock.runFor(5500);
  // Folded: one short line instead of the row, and nothing removed.
  await expect(failure).toHaveCount(0);
  await expect(panel(page)).toContainText(/Eine Übertragung beendet · eine mit Fehlern|One transfer ended · one with errors/);
  expect(await listedJobs(page)).toContain(job.id);
  expect((await panel(page).boundingBox())!.height).toBeLessThan(full);

  // Another page shows it again, and folds it again; it is never cleared by itself.
  await page.reload();
  await expect(failure).toBeVisible();
  await page.clock.runFor(60_000);
  await expect(panel(page)).toContainText(/Eine Übertragung beendet|One transfer ended/);
  expect(await listedJobs(page)).toContain(job.id);

  const show = panel(page).getByRole('button', { name: /^(Anzeigen|Show)$/ });
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await show.click();
  await expect(panel(page).getByRole('button', { name: /^(Ausblenden|Hide)$/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(failure).toBeVisible();
  await panel(page).getByRole('button', { name: /report\.txt (aus der Liste entfernen|from the list)/ }).click();
  await expect(panel(page)).toHaveCount(0);
  expect(await listedJobs(page)).not.toContain(job.id);
});
