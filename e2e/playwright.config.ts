import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './freePort.ts';

// Config is re-evaluated in worker processes; workers inherit env from the runner, so pick once.
process.env.E2E_PORT ??= String(await freePort());
// A second server with the fake cloud provider (#148, e2e/cloudServer.ts); e2e/connections.spec.ts runs against it.
process.env.E2E_CLOUD_PORT ??= String(await freePort());
// The main server's log as well as on stdout (globalSetup.ts), so a test can read what the server logged (#298).
process.env.E2E_SERVER_LOG ??= join(tmpdir(), `files-e2e-server-${process.env.E2E_PORT}.log`);

// Screenshot baselines must match on the CI runner as well as on the host that made them (#318). Every glyph comes from
// the bundled fonts (e2e/fonts.ts checks it); these switches stop Chromium from taking hinting, subpixel positioning,
// LCD anti-aliasing and the colour profile from the machine's fontconfig and display settings.
const sameOnEveryMachine = { args: ['--font-render-hinting=none', '--disable-font-subpixel-positioning', '--disable-lcd-text',
  '--force-color-profile=srgb'] };

export default defineConfig({
  testDir: '.',
  globalSetup: './globalSetup.ts',
  fullyParallel: false, workers: 1, retries: 0, forbidOnly: true,
  // What stays after that is grey-level anti-aliasing at glyph edges; 0.2 % of a view's pixels is far below one changed
  // word, a theme or a moved control.
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002 } },
  use: { baseURL: `http://localhost:${process.env.E2E_PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'], launchOptions: sameOnEveryMachine } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'], launchOptions: sameOnEveryMachine } },
    // Firefox checks what depends on its engine: the PDF preview under `CSP: sandbox` (#143).
    { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'] }, testMatch: ['pdf-preview.spec.ts'] },
  ],
});
