import { defineConfig } from 'vitest/config';
export default defineConfig({
  // Live provider tests run only under `pnpm test:live` (vitest.live.config.ts), litmus only under `pnpm test:litmus`.
  test: { environment: 'node', pool: 'forks', testTimeout: 15000, env: { NODE_ENV: 'production' },
    exclude: ['test/live/**', 'test/litmus/**', '**/node_modules/**'] },
});
