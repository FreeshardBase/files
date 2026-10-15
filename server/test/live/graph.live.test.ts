import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { OAuthClient, systemClock } from '../../src/cloud/oauth.ts';
import { graphProviders } from '../../src/cloud/graph.ts';

// #151, live against the real Microsoft Graph: list the OneDrive root, upload a temporary file, download it, delete it.
// Runs only with LIVE_GRAPH_REFRESH_TOKEN, LIVE_GRAPH_CLIENT_ID and LIVE_GRAPH_CLIENT_SECRET (server/.env.live;
// LIVE_GRAPH_TENANT is optional, `common` without it); otherwise the suite is skipped, never passed. The temporary file
// ends in the OneDrive recycle bin, like every delete of the app.
const vars = ['REFRESH_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET'].map((v) => process.env[`LIVE_GRAPH_${v}`]);
const [refresh, clientId, clientSecret] = vars;

describe.skipIf(vars.some((v) => !v))('live: OneDrive backend (LIVE_GRAPH_*)', () => {
  it('lists the root, uploads, downloads and deletes a temporary file', async () => {
    const [provider] = graphProviders({ clientId: clientId!, clientSecret: clientSecret!, tenant: process.env.LIVE_GRAPH_TENANT || 'common' });
    let stored = refresh!;
    const client = new OAuthClient(provider!, { refreshToken: () => stored, saveRefreshToken: (t) => { stored = t; }, setStatus: () => undefined },
      systemClock);
    expect((await provider!.account(client)).id.length).toBeGreaterThan(0);
    const onedrive = provider!.backend(client, '');
    const root = await onedrive.list('/');
    expect(Array.isArray(root.entries)).toBe(true);

    const name = `/freeshard-files-live-${randomBytes(6).toString('hex')}.txt`;
    const body = Buffer.from(`live test ${new Date().toISOString()}`);
    const written = await onedrive.write(name, Readable.from([body]), { onCollision: 'fail', maxBytes: 1024 * 1024, size: body.length });
    try {
      expect(written).toEqual(expect.objectContaining({ path: name, type: 'file', size: body.length }));
      const { stream } = await onedrive.read(name);
      const parts: string[] = [];
      for await (const c of stream) parts.push((c as Buffer).toString());
      expect(parts.join('')).toBe(body.toString());
    } finally {
      await onedrive.delete([name]);
    }
    await expect(onedrive.stat(name)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The token itself is never printed; only that it changed, so the env file can be updated through the UI flow.
    if (stored !== refresh) console.warn('Microsoft rotated the refresh token; reconnect to refresh LIVE_GRAPH_REFRESH_TOKEN');
  });
});
