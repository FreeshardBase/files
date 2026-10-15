import { build } from 'esbuild';
import { rmSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/main.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm',
  outfile: 'dist/main.js', sourcemap: true,
  external: ['better-sqlite3', 'pino', 'fastify', '@fastify/*', 'openid-client'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
