import { defineConfig } from 'vitest/config';

// `pnpm test:litmus`: the litmus WebDAV suites in a container against the server (#157, spec §3.9).
export default defineConfig({
  test: { environment: 'node', pool: 'forks', testTimeout: 120_000, hookTimeout: 600_000, env: { NODE_ENV: 'production' },
    include: ['test/litmus/**/*.test.ts'] },
});
