import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { OAuthClient, systemClock } from '../../src/cloud/oauth.ts';
import { googleDriveProvider } from '../../src/cloud/googleDrive.ts';

// #149, live against the real Google Drive: list the root, upload a temporary file, download it, move it to the trash.
// Runs only with LIVE_GDRIVE_REFRESH_TOKEN, LIVE_GDRIVE_CLIENT_ID and LIVE_GDRIVE_CLIENT_SECRET (server/.env.live);
// otherwise the suite is skipped, never passed. The temporary file ends in Drive's trash, like every delete of the app.
const vars = ['REFRESH_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET'].map((v) => process.env[`LIVE_GDRIVE_${v}`]);
const [refresh, clientId, clientSecret] = vars;

describe.skipIf(vars.some((v) => !v))('live: Google Drive backend (LIVE_GDRIVE_*)', () => {
  it('lists the root, uploads, downloads and deletes a temporary file', async () => {
    const provider = googleDriveProvider({ clientId: clientId!, clientSecret: clientSecret! });
    let stored = refresh!;
    const client = new OAuthClient(provider, { refreshToken: () => stored, saveRefreshToken: (t) => { stored = t; }, setStatus: () => undefined },
      systemClock);
    expect((await provider.account(client)).id.length).toBeGreaterThan(0);
    const drive = provider.backend(client, '');
    const root = await drive.list('/');
    expect(Array.isArray(root.entries)).toBe(true);

    const name = `/freeshard-files-live-${randomBytes(6).toString('hex')}.txt`;
    const body = Buffer.from(`live test ${new Date().toISOString()}`);
    const written = await drive.write(name, Readable.from([body]), { onCollision: 'fail', maxBytes: 1024 * 1024, size: body.length });
    try {
      expect(written).toEqual(expect.objectContaining({ path: name, type: 'file', size: body.length }));
      const { stream } = await drive.read(name);
      const parts: string[] = [];
      for await (const c of stream) parts.push((c as Buffer).toString());
      expect(parts.join('')).toBe(body.toString());
    } finally {
      await drive.delete([name]);
    }
    await expect(drive.stat(name)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    if (stored !== refresh) console.warn('Google rotated the refresh token; reconnect to refresh LIVE_GDRIVE_REFRESH_TOKEN');
  });
});
