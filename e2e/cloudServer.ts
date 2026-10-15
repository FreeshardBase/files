// The E2E server for cloud connections (#148): the same `buildApp` as server/dist/main.js, run from the sources with the
// fake provider (server/test/support/fakeProvider.ts) as its cloud providers: the generic "Fake Cloud" and the real
// Google Drive, Dropbox, OneDrive and SharePoint providers pointed at the fake's Drive (#149), Dropbox (#150) and
// Microsoft Graph (#151). The production bundle offers
// only providers with configured credentials, and test code never goes into it, so the rest of the suite keeps running
// against the bundle.
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
fake.dropbox.put('/Reports/Q3 Übersicht.txt', 'third quarter, from dropbox');
fake.graph.put('/Documents/Plan 2027.txt', 'next year, from onedrive');
fake.graph.addSite('contoso.sharepoint.com,11111111-aaaa,22222222-bbbb', 'Team Site', [['b!team-documents', 'Documents'], ['b!team-archive', 'Archive']]);
fake.graph.addSite('contoso.sharepoint.com,33333333-cccc,44444444-dddd', 'Marketing', [['b!marketing-assets', 'Assets']]);
fake.graph.put('/Projects/brief.txt', 'the team brief, from sharepoint', { drive: 'b!team-documents' });
// e2e/migration.spec.ts (#153): one folder per project to migrate and clean up, with one download that breaks halfway.
for (const project of ['desktop-chrome', 'mobile-chrome']) {
  fake.put(`/Move-${project}/letter.txt`, 'dear testuser');
  fake.put(`/Move-${project}/Photos/beach.txt`, 'a photo, as text');
  fake.put(`/Move-${project}/broken.txt`, 'this download stops halfway');
  fake.truncateContent(`/Move-${project}/broken.txt`);
}
const config = loadConfig(process.env);
const db = openDb(dbPath(config.dataDir));
const app = await buildApp({ config, db, providers: [fake.provider(), fake.driveProvider(), fake.dropboxProvider(), ...fake.graphProviders()] });
await app.listen({ port: config.port, host: '127.0.0.1' });

const stop = () => {
  app.close().then(async () => { db.close(); await fake.close(); process.exit(0); },
    (err) => { console.error('cloud E2E server shutdown failed', err); process.exit(1); });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
