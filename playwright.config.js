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
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:3099',
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
    headless: true,
  },
  webServer: {
    command: 'PORT=3099 AUTH_METHOD=local node server/index.js',
    url: 'http://127.0.0.1:3099/api/health',
    reuseExistingServer: true,
    timeout: 30000,
    env: {
      PORT: '3099',
      E2E_TEST: 'true',
      AUTO_OIDC_LOGIN: 'false',
      ENABLE_LOCAL_AUTH: 'true'
    }
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],
});
