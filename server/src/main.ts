import { join } from 'node:path';
import { loadConfig, ConfigError, type Config } from './config.ts';
import { openDb } from './db.ts';
import { buildApp } from './app.ts';

process.on('unhandledRejection', (err) => { console.error('unhandledRejection', err); process.exit(1); });
process.on('uncaughtException', (err) => { console.error('uncaughtException', err); process.exit(1); });

let config: Config;
try { config = loadConfig(process.env); }
catch (err) {
  if (err instanceof ConfigError) { console.error(err.message); process.exit(1); }
  throw err;
}
const db = openDb(join(config.dataDir, 'files.db'));
const app = await buildApp({ config, db });
await app.listen({ port: config.port, host: '0.0.0.0' });
