import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// #298: an error in the browser reaches the server's log, with the route's name and without the folder's path.
const serverLog = () => {
  const file = process.env.E2E_SERVER_LOG;
  if (!file) throw new Error('E2E_SERVER_LOG not set (playwright.config.ts sets it)');
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);
};
type ClientError = { message: string; route: string; build: string; userAgent: string; stack?: string };
const logged = (marker: string) => serverLog().filter((l) => l.msg === 'client error' && (l.clientError as ClientError).message.includes(marker));

test('an uncaught error and a rejected promise in the browser are logged on the server', async ({ page }, info) => {
  await page.goto('/home/Private%20Notes');
  await expect(page.getByRole('navigation', { name: /Orte|Places/ })).toBeVisible();
  // Spaces keep the marker from looking like a token, which the redaction would replace.
  const marker = `e2e ${info.project.name} ${Date.now()}`;
  await page.evaluate((m) => {
    setTimeout(() => { throw new Error(`thrown ${m}`); });
    void Promise.reject(new Error(`rejected ${m}`));
  }, marker);

  await expect.poll(() => logged(marker).length, { timeout: 10_000 }).toBe(2);
  const lines = logged(marker);
  expect(lines.map((l) => (l.clientError as ClientError).message).sort()).toEqual([`Error: rejected ${marker}`, `Error: thrown ${marker}`]);
  for (const l of lines) {
    expect(l.level).toBe(40);
    expect(l.userId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(l.clientError).toMatchObject({ route: 'folder', build: expect.stringMatching(/^index-.+\.js$/),
      userAgent: await page.evaluate(() => navigator.userAgent) });
    expect(JSON.stringify(l)).not.toContain('Private');
  }
});
