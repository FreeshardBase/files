import { OAuthClient, systemClock, type Provider } from '../../src/cloud/oauth.ts';
import { googleDriveProvider } from '../../src/cloud/googleDrive.ts';
import { dropboxProvider } from '../../src/cloud/dropbox.ts';
import { pcloudCredential, pcloudProvider } from '../../src/cloud/pcloud.ts';
import type { StorageBackend } from '../../src/storage/backend.ts';

// The real providers the live suites run against, each with the LIVE_<PREFIX>_* variables it needs (server/.env.live).
// A suite whose variables are missing is skipped, never passed.
export type Live = { name: string; prefix: string; vars: readonly string[];
  /** The provider and the credential its connection would store (a refresh token, or pCloud's token with its host). */
  make: (v: Record<string, string>) => { provider: Provider; credential: string } };

const creds = (v: Record<string, string>) => ({ clientId: v.CLIENT_ID!, clientSecret: v.CLIENT_SECRET! });
export const GDRIVE: Live = { name: 'Google Drive', prefix: 'GDRIVE', vars: ['REFRESH_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET'],
  make: (v) => ({ provider: googleDriveProvider(creds(v)), credential: v.REFRESH_TOKEN! }) };
export const DROPBOX: Live = { name: 'Dropbox', prefix: 'DROPBOX', vars: ['REFRESH_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET'],
  make: (v) => ({ provider: dropboxProvider(creds(v)), credential: v.REFRESH_TOKEN! }) };
// pCloud's token never expires and has no refresh token; the API host of the account's region comes with it (#211):
// `api.pcloud.com` (US) or `eapi.pcloud.com` (EU), as the consent named it.
export const PCLOUD: Live = { name: 'pCloud', prefix: 'PCLOUD', vars: ['ACCESS_TOKEN', 'HOSTNAME', 'CLIENT_ID', 'CLIENT_SECRET'],
  make: (v) => ({ provider: pcloudProvider(creds(v)), credential: pcloudCredential(v.HOSTNAME!, v.ACCESS_TOKEN!) }) };

/** The variables of `p` without their prefix, or undefined when one is missing. */
export function liveEnv(p: Live): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const v of p.vars) {
    const value = process.env[`LIVE_${p.prefix}_${v}`];
    if (!value) return undefined;
    out[v] = value;
  }
  return out;
}

/** A client and backend of `p` on an in-memory token store; `stored()` is the credential as it is now (rotated or not). */
export function liveBackend(p: Live, env: Record<string, string>) {
  const { provider, credential } = p.make(env);
  let stored = credential;
  const client = new OAuthClient(provider, { refreshToken: () => stored, saveRefreshToken: (t) => { stored = t; }, setStatus: () => undefined },
    systemClock);
  return { provider, client, backend: provider.backend(client, '') as StorageBackend, rotated: () => stored !== credential };
}
