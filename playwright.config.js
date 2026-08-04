const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:3005',
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
    headless: true,
  },
  webServer: {
    command: 'node server/index.js',
    url: 'http://127.0.0.1:3005/api/health',
    reuseExistingServer: true,
    timeout: 30000,
    env: {
      E2E_TEST: 'true',
      AUTO_OIDC_LOGIN: 'false',
      ENABLE_LOCAL_AUTH: 'true'
    }
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
