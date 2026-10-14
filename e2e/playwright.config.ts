import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  globalSetup: './globalSetup.ts',
  fullyParallel: false, workers: 1, retries: 0, forbidOnly: true,
  use: { baseURL: 'http://localhost:3199', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
  ],
});
