import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// `pnpm test:live`: tests against the real providers (spec §3.9). Their refresh tokens and client credentials come from
// the untracked `server/.env.live` (or the environment); a suite whose `LIVE_*` variables are missing reports skipped.
const envFile = new URL('./.env.live', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: { environment: 'node', pool: 'forks', testTimeout: 60_000, env: { NODE_ENV: 'production' },
    include: ['test/live/**/*.live.test.ts'] },
});
