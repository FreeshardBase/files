import { defineConfig } from 'vitest/config';

// The load test measures event-loop stalls and RSS growth; running beside other test files (the 2 GB tus upload)
// starves it of CPU, so it runs in its own group after every other file has finished (#318).
const LOAD_TESTS = ['test/load.test.ts'];
const EXCLUDE = ['test/live/**', 'test/litmus/**', '**/node_modules/**'];

export default defineConfig({
  // Live provider tests run only under `pnpm test:live` (vitest.live.config.ts), litmus only under `pnpm test:litmus`.
  test: { environment: 'node', pool: 'forks', testTimeout: 15000, env: { NODE_ENV: 'production' }, exclude: EXCLUDE,
    projects: [
      { extends: true, test: { name: 'server', exclude: [...LOAD_TESTS, ...EXCLUDE], sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: 'load', include: LOAD_TESTS, sequence: { groupOrder: 1 } } },
    ] },
});
