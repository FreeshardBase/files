import { randomBytes } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openPlaces } from './places.ts';

// #216: the duplicate finder. Two identical files and one of the same size with other bytes: the search groups the
// identical two only; "keep the oldest" only picks; one copy can never be picked; the picked copy goes to the trash
// after a confirmation. Both projects share one server and one `testuser`, whose home holds other tests' files too, so
// this test only ever picks its own copies.
const tag = (info: TestInfo) => `${info.project.name}-${info.repeatEachIndex}-${info.retry}`;

async function put(page: Page, path: string, data: Buffer) {
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin, 'content-type': 'application/octet-stream' };
  const r = await page.request.put(`/api/v1/sources/home/content?path=${encodeURIComponent(path)}&onCollision=fail`, { headers, data });
  expect(r.status()).toBe(201);
}

test('find two identical files, keep the oldest and move the other copy to the trash', async ({ page }, info) => {
  // Under one parent that sorts last, so the home's root (windowed beyond 200 entries) keeps other tests' rows in place.
  const dir = `zz-duplicates-216/dups-${tag(info)}`;
  const same = randomBytes(1200);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: /Pfad|Path/ })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/v1/me')).json();
  const headers = { 'x-csrf-token': csrfToken, origin: new URL(page.url()).origin };
  expect([201, 409]).toContain((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: '/zz-duplicates-216' } })).status());
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}` } })).status()).toBe(201);
  // Copies come oldest first, by path when two have the same time: "original" sorts before "zbackup/…" either way.
  expect((await page.request.post('/api/v1/sources/home/mkdir', { headers, data: { path: `/${dir}/zbackup` } })).status()).toBe(201);
  const original = `original-${tag(info)}.bin`;
  const copy = `copy-${tag(info)}.bin`;
  const other = `other-${tag(info)}.bin`;
  await put(page, `/${dir}/${original}`, same);
  await put(page, `/${dir}/zbackup/${copy}`, same);
  await put(page, `/${dir}/${other}`, randomBytes(1200));

  const nav = await openPlaces(page);
  await nav.getByRole('link', { name: /^\s*(Doppelte Dateien|Duplicates)\s*$/ }).click();
  await expect(page.getByRole('heading', { name: /^(Doppelte Dateien|Duplicates)$/, level: 1 })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /^(Mein Speicher|My storage)$/ })).toBeChecked();
  await page.getByRole('button', { name: /^(Doppelte Dateien suchen|Find duplicates|Erneut suchen|Search again)$/ }).click();

  const group = page.locator('.duplicate-group', { has: page.getByText(copy, { exact: true }) });
  await expect(group).toBeVisible({ timeout: 30_000 });
  await expect(group.getByRole('heading')).toHaveText(/2 (Kopien zu je|copies of)/);
  await expect(group.locator('.duplicate-copy')).toHaveCount(2);
  await expect(group.getByText(original, { exact: true })).toBeVisible();
  // Equal size, other content: in no group.
  await expect(page.getByText(other, { exact: true })).toHaveCount(0);

  const originalBox = group.getByRole('checkbox', { name: new RegExp(original.replace(/\./g, '\\.')) });
  const copyBox = group.getByRole('checkbox', { name: new RegExp(copy.replace(/\./g, '\\.')) });
  // "Keep the oldest" only picks: the original stays unpicked and cannot be picked, the copy is picked.
  await page.getByRole('button', { name: /^(Älteste behalten, Rest auswählen|Keep the oldest, pick the rest)$/ }).click();
  await expect(copyBox).toBeChecked();
  await expect(originalBox).not.toBeChecked();
  await expect(originalBox).toBeDisabled();
  // Other tests' groups were picked too; only this test's copy is moved.
  await page.getByRole('button', { name: /^(Nichts auswählen|Pick none)$/ }).click();
  await expect(copyBox).not.toBeChecked();
  await copyBox.check();
  await expect(originalBox).toBeDisabled();

  await page.getByRole('button', { name: /^(Eine Datei in den Papierkorb|Move one file to the trash)$/ }).click();
  const confirm = page.getByRole('dialog', { name: /In den Papierkorb verschieben\?|Move to the trash\?/ });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: /^(In den Papierkorb|Move to the trash)$/ }).click();
  await expect(page.getByText(/^(Eine Datei in den Papierkorb verschoben|One file moved to the trash)$/)).toBeVisible();
  await expect(group).toHaveCount(0);

  // The copy is in the trash, the original where it was.
  await (await openPlaces(page)).getByRole('link', { name: /Papierkorb|Trash/ }).click();
  await expect(page.getByRole('heading', { name: /Papierkorb|Trash/ })).toBeVisible();
  await expect(page.locator('tbody tr', { hasText: copy })).toBeVisible();
  const list = await (await page.request.get(`/api/v1/sources/home/list?path=${encodeURIComponent(`/${dir}`)}`)).json();
  expect((list.entries as { name: string }[]).map((e) => e.name).sort()).toEqual([original, other, 'zbackup'].sort());
});
