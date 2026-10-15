import { build } from 'esbuild';
import { rmSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
await build({
  // main.js is the server, reindex.js the name-index rebuild command (#145).
  entryPoints: ['src/main.ts', 'src/reindex.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm',
  outdir: 'dist', sourcemap: true,
  external: ['better-sqlite3', 'pino', 'fastify', '@fastify/*', 'openid-client', 'sharp'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
