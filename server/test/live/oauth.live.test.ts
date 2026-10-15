import { describe, expect, it } from 'vitest';
import { OAuthClient, systemClock, type Provider } from '../../src/cloud/oauth.ts';
import { GOOGLE_DRIVE_ENDPOINTS } from '../../src/cloud/googleDrive.ts';
import { DROPBOX_ENDPOINTS } from '../../src/cloud/dropbox.ts';
import { graphEndpoints } from '../../src/cloud/graph.ts';

// Live check of the OAuthClient against each provider's real token endpoint: a stored refresh token yields an access
// token, and a rotated refresh token reaches the store. Runs only with `LIVE_<P>_REFRESH_TOKEN`, `LIVE_<P>_CLIENT_ID` and
// `LIVE_<P>_CLIENT_SECRET` (server/.env.live); otherwise the suite is skipped, never passed. The endpoints come from the
// provider modules (#149–#151), whose backends' live tests sit next to this one.
const LIVE = [
  { name: 'Google Drive', env: 'GDRIVE', tokenEndpoint: GOOGLE_DRIVE_ENDPOINTS.token },
  { name: 'Dropbox', env: 'DROPBOX', tokenEndpoint: DROPBOX_ENDPOINTS.token },
  { name: 'Microsoft Graph', env: 'GRAPH', tokenEndpoint: graphEndpoints(process.env.LIVE_GRAPH_TENANT || 'common').token },
];

const unused = (): never => { throw new Error('not part of the live token check'); };

for (const p of LIVE) {
  const vars = ['REFRESH_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET'].map((v) => process.env[`LIVE_${p.env}_${v}`]);
  const [refresh, clientId, clientSecret] = vars;
  describe.skipIf(vars.some((v) => !v))(`live: ${p.name} (LIVE_${p.env}_*)`, () => {
    it('refreshes an access token with the stored refresh token', async () => {
      const provider: Provider = { id: p.env.toLowerCase(), name: p.name, authorizationEndpoint: p.tokenEndpoint,
        tokenEndpoint: p.tokenEndpoint, clientId: clientId!, clientSecret: clientSecret!, scopes: [], pkce: false,
        account: unused, backend: unused };
      let stored = refresh!; const statuses: string[] = [];
      const client = new OAuthClient(provider, { refreshToken: () => stored, saveRefreshToken: (t) => { stored = t; },
        setStatus: (s) => { statuses.push(s); } }, systemClock);
      expect((await client.accessToken()).length).toBeGreaterThan(0);
      expect(statuses).toEqual(['ok']);
      // The token itself is never printed; only that it changed, so the env file can be updated through the UI flow.
      if (stored !== refresh) console.warn(`${p.name} rotated the refresh token; reconnect to refresh LIVE_${p.env}_REFRESH_TOKEN`);
    });
  });
}
