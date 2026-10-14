import { defineConfig, devices } from '@playwright/test';
import { freePort } from './freePort.ts';

// Config is re-evaluated in worker processes; workers inherit env from the runner, so pick once.
process.env.E2E_PORT ??= String(await freePort());

export default defineConfig({
  testDir: '.',
  globalSetup: './globalSetup.ts',
  fullyParallel: false, workers: 1, retries: 0, forbidOnly: true,
  use: { baseURL: `http://localhost:${process.env.E2E_PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
  ],
});
