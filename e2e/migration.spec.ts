import { expect, test, type Page } from '@playwright/test';
import { openPlaces } from './places.ts';

// #153: the migration wizard against the cloud server (e2e/cloudServer.ts), whose generic fake cloud holds
// /Move-<project>/ with letter.txt, Photos/beach.txt and broken.txt, whose download stops halfway. The member picks the
// folder, reviews the count, starts, watches the progress, reads the summary with the failure, exports it, confirms the
// cleanup in a dialog, and the cloud folder is left with only the file that was not verified.
test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_CLOUD_PORT}` });

const nav = (page: Page) => page.getByRole('navigation', { name: /Orte|Places/ });

/** Signs in as testuser with exactly one Fake Cloud connection and an empty transfer list. */
async function connected(page: Page) {
  await page.goto('/auth/login?returnTo=%2Fconnections');
  await expect(page.getByRole('heading', { name: /Cloud-Konten|Cloud accounts/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  for (const c of (await (await page.request.get('/api/v1/connections')).json()).items as { id: string }[]) {
    expect((await page.request.delete(`/api/v1/connections/${c.id}`, { headers })).status()).toBe(204);
  }
  expect((await page.request.post('/api/v1/transfers/clear', { headers })).status()).toBe(204);
  await page.reload();
  await page.getByRole('button', { name: /Fake Cloud verbinden|Connect Fake Cloud/ }).click();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/conn:[0-9a-f]{32}$/);
  return new URL(page.url()).pathname.slice(1);
}

test('migrate a cloud folder with the wizard, read the summary, and delete only the verified originals', async ({ page }, info) => {
  const source = await connected(page);
  const folder = `Move-${info.project.name}`;

  await openPlaces(page);
  await nav(page).getByRole('link', { name: /Auf den Shard umziehen|Move to shard/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Auf den Shard umziehen|Move to the shard/ })).toBeVisible();
  // 1. The only connection is chosen; open its folder in the picker.
  await expect(page.getByRole('radio', { name: /Fake Cloud: testuser@example\.com/ })).toBeChecked();
  const cloud = page.getByRole('navigation', { name: /Ordner in der Cloud|Folder in the cloud/ });
  await expect(cloud.getByRole('button', { name: /Fake Cloud/ })).toHaveAttribute('aria-current', 'location');
  await page.getByRole('button', { name: folder, exact: true }).click();
  await expect(cloud.getByRole('button', { name: folder })).toHaveAttribute('aria-current', 'location');
  await expect(page.getByRole('button', { name: 'Photos', exact: true })).toBeVisible();
  await expect(page.getByText(new RegExp(`(Zieht um|Moves): Fake Cloud: testuser@example\\.com/${folder}$`))).toBeVisible();
  await page.getByRole('button', { name: /^(Weiter|Next)$/ }).click();

  // 2. Into the home's root, under the folder's own name.
  await expect(page.getByRole('heading', { level: 2, name: /2\./ })).toBeFocused();
  const name = page.getByLabel(/Name des neuen Ordners|Name of the new folder/);
  await expect(name).toHaveValue(folder);
  await name.fill(`${folder} archive`);
  await page.getByRole('button', { name: /^(Weiter|Next)$/ }).click();

  // 3. The review counts what will move.
  await expect(page.getByTestId('scan-files')).toHaveText('3');
  await page.getByRole('button', { name: /Umzug starten|Start migration/ }).click();

  // The job's page: progress, then the summary with the one failure.
  await expect(page).toHaveURL(/\/migrate\/[0-9a-f]{32}$/);
  const jobUrl = new URL(page.url()).pathname;
  await expect(page.getByRole('progressbar', { name: new RegExp(`(Umzugs von|migration of) ${folder} archive`) })).toHaveAttribute('aria-valuenow', '100');
  const summary = page.getByRole('region', { name: /^(Zusammenfassung|Summary)$/ });
  await expect(summary.getByTestId('verified-files')).toHaveText('2');
  await expect(summary.getByRole('list', { name: /Nicht umgezogene|not moved/ })).toContainText(`/${folder}/broken.txt`);
  // The transfer panel links the job to this page.
  await expect(page.getByRole('region', { name: /^(Übertragungen|Transfers)$/ }).getByRole('link', { name: /Zusammenfassung von|Summary of/ }))
    .toHaveAttribute('href', jobUrl);

  // The export is a CSV with every item.
  const exportLink = summary.getByRole('link', { name: /Zusammenfassung exportieren|Export summary/ });
  const csv = await (await page.request.get(String(await exportLink.getAttribute('href')))).text();
  expect(csv).toContain(`"failed","/${folder}/broken.txt","","file","0","","SIZE_MISMATCH"`);
  expect(csv).toContain(`"done","/${folder}/letter.txt","/${folder} archive/letter.txt","file","13","size sha256",""`);

  // Cleanup: Esc in the dialog deletes nothing; confirming deletes the verified originals.
  const start = page.getByRole('button', { name: /Geprüfte Originale löschen|Delete verified originals/ });
  await start.click();
  const dialog = page.getByRole('dialog', { name: /Geprüfte Originale löschen|Delete the verified originals/ });
  await expect(dialog).toContainText(/2 (geprüfte Dateien|verified files)/);
  await expect(dialog.getByRole('button', { name: /^(Abbrechen|Cancel)$/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(start).toBeFocused();
  await start.click();
  await dialog.getByRole('button', { name: /^(Originale löschen|Delete originals)$/ }).click();
  await expect(dialog).toHaveCount(0);
  const cleanup = page.getByRole('region', { name: /^(Originale in der Cloud|Originals in the cloud)$/ });
  await expect(cleanup.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await expect(cleanup.getByTestId('deleted-files')).toHaveText('2');
  await expect(cleanup).toContainText(/Fertig|Done/);

  // The cloud folder keeps only the file that was not verified (and its folders); the shard has the verified copies.
  const list = async (src: string, path: string) => ((await (await page.request.get(
    `/api/v1/sources/${encodeURIComponent(src)}/list?path=${encodeURIComponent(path)}`)).json()).entries as { name: string }[]).map((e) => e.name).sort();
  expect(await list(source, `/${folder}`)).toEqual(['Photos', 'broken.txt']);
  expect(await list(source, `/${folder}/Photos`)).toEqual([]);
  expect(await list('home', `/${folder} archive`)).toEqual(['Photos', 'letter.txt']);
});

// #227: opening /migrate directly (a reload, a bookmark) works like navigating there: the connection is chosen and
// step 2 proposes its name.
test('a direct load of the wizard preselects the connection and proposes the folder name', async ({ page }) => {
  await connected(page);
  for (const open of [() => page.goto('/migrate'), () => page.reload()]) {
    await open();
    await expect(page.getByRole('radio', { name: /Fake Cloud: testuser@example\.com/ })).toBeChecked();
    await page.getByRole('button', { name: /^(Weiter|Next)$/ }).click();
    await expect(page.getByLabel(/Name des neuen Ordners|Name of the new folder/)).toHaveValue('Fake Cloud testuser@example.com');
    await expect(page.getByRole('button', { name: /^(Weiter|Next)$/ })).toBeEnabled();
  }
});

// #227: the job's page counts files like the scan did and says "Counting …" until every folder is listed, instead of a
// total that only knows the migrated folder itself; its heading follows the job once it has ended.
test('the job page counts until the folders are listed, and its heading follows the ended job', async ({ page }, info) => {
  await connected(page);
  const name = `Notes ${info.project.name}`;
  // Without the event stream the page shows the job as the start answered it: only its folder is known yet.
  await page.route('**/api/v1/transfers/events', (r) => r.abort());
  await page.goto('/migrate');
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.getByRole('button', { name: /^(Weiter|Next)$/ }).click();
  await page.getByLabel(/Name des neuen Ordners|Name of the new folder/).fill(name);
  await page.getByRole('button', { name: /^(Weiter|Next)$/ }).click();
  await expect(page.getByTestId('scan-files')).toHaveText('1');
  await page.getByRole('button', { name: /Umzug starten|Start migration/ }).click();
  await expect(page).toHaveURL(/\/migrate\/[0-9a-f]{32}$/);
  await expect(page.locator('.migrate-state')).toHaveText(/^(Wird gezählt …|Counting …)$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(new RegExp(`^(„${name}“ zieht auf den Shard um|Moving “${name}” to the shard)$`));
  await page.unroute('**/api/v1/transfers/events');
  await page.reload();
  await expect(page.locator('.migrate-state')).toHaveText(/^(Fertig|Done)$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(new RegExp(`^(„${name}“ ist auf den Shard umgezogen|“${name}” moved to the shard)$`));
});
