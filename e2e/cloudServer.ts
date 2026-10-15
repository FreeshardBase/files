// The E2E server for cloud connections (#148): the same `buildApp` as server/dist/main.js, run from the sources with the
// fake provider (server/test/support/fakeProvider.ts) as its cloud providers: the generic "Fake Cloud" and the real
// Google Drive provider pointed at the fake's Drive (#149). The production bundle offers only providers with configured
// credentials, and test code never goes into it, so the rest of the suite keeps running against the bundle.
import { loadConfig } from '../server/src/config.ts';
import { openDb } from '../server/src/db.ts';
import { buildApp } from '../server/src/app.ts';
import { dbPath } from '../server/src/paths.ts';
import { startFakeProvider } from '../server/test/support/fakeProvider.ts';
import { NATIVE, solidPng } from '../server/test/support/fakeDrive.ts';

const fake = await startFakeProvider();
fake.put('/Notes/hello.txt', 'hello from the fake cloud');
fake.put('/report.txt', 'quarterly numbers');
fake.drive.put('/Photos/sunset.png', await solidPng(400, 300, '#c8761f'), { mimeType: 'image/png', thumbnail: true });
fake.drive.put('/Budget', null, { mimeType: NATIVE.spreadsheet });
const config = loadConfig(process.env);
const db = openDb(dbPath(config.dataDir));
const app = await buildApp({ config, db, providers: [fake.provider(), fake.driveProvider()] });
await app.listen({ port: config.port, host: '127.0.0.1' });

const stop = () => {
  app.close().then(async () => { db.close(); await fake.close(); process.exit(0); },
    (err) => { console.error('cloud E2E server shutdown failed', err); process.exit(1); });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
