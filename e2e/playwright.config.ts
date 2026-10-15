import { defineConfig, devices } from '@playwright/test';
import { freePort } from './freePort.ts';

// Config is re-evaluated in worker processes; workers inherit env from the runner, so pick once.
process.env.E2E_PORT ??= String(await freePort());
// A second server with the fake cloud provider (#148, e2e/cloudServer.ts); e2e/connections.spec.ts runs against it.
process.env.E2E_CLOUD_PORT ??= String(await freePort());

export default defineConfig({
  testDir: '.',
  globalSetup: './globalSetup.ts',
  fullyParallel: false, workers: 1, retries: 0, forbidOnly: true,
  use: { baseURL: `http://localhost:${process.env.E2E_PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    // Firefox checks what depends on its engine: the PDF preview under `CSP: sandbox` (#143).
    { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'] }, testMatch: ['pdf-preview.spec.ts'] },
  ],
});
