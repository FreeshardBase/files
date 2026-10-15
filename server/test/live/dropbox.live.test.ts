import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { OAuthClient, systemClock } from '../../src/cloud/oauth.ts';
import { dropboxProvider } from '../../src/cloud/dropbox.ts';

// #150, live against the real Dropbox: list the root, upload a temporary file, download it, delete it.
// Runs only with LIVE_DROPBOX_REFRESH_TOKEN, LIVE_DROPBOX_CLIENT_ID and LIVE_DROPBOX_CLIENT_SECRET (server/.env.live);
// otherwise the suite is skipped, never passed. The temporary file ends in Dropbox's deleted files, like every delete of the app.
const vars = ['REFRESH_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET'].map((v) => process.env[`LIVE_DROPBOX_${v}`]);
const [refresh, clientId, clientSecret] = vars;

describe.skipIf(vars.some((v) => !v))('live: Dropbox backend (LIVE_DROPBOX_*)', () => {
  it('lists the root, uploads, downloads and deletes a temporary file', async () => {
    const provider = dropboxProvider({ clientId: clientId!, clientSecret: clientSecret! });
    let stored = refresh!;
    const client = new OAuthClient(provider, { refreshToken: () => stored, saveRefreshToken: (t) => { stored = t; }, setStatus: () => undefined },
      systemClock);
    expect((await provider.account(client)).id.length).toBeGreaterThan(0);
    const dropbox = provider.backend(client);
    const root = await dropbox.list('/');
    expect(Array.isArray(root.entries)).toBe(true);

    const name = `/freeshard-files-live-${randomBytes(6).toString('hex')}.txt`;
    const body = Buffer.from(`live test ${new Date().toISOString()}`);
    const written = await dropbox.write(name, Readable.from([body]), { onCollision: 'fail', maxBytes: 1024 * 1024, size: body.length });
    try {
      expect(written).toEqual(expect.objectContaining({ path: name, type: 'file', size: body.length }));
      const { stream } = await dropbox.read(name);
      const parts: string[] = [];
      for await (const c of stream) parts.push((c as Buffer).toString());
      expect(parts.join('')).toBe(body.toString());
    } finally {
      await dropbox.delete([name]);
    }
    await expect(dropbox.stat(name)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
