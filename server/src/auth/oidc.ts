import * as client from 'openid-client';
import type { Config } from '../config.ts';

export type Oidc = {
  authorizationUrl(p: { state: string; nonce: string; challenge: string; loginHint?: string }): URL;
  exchange(callbackUrl: URL, p: { state: string; nonce: string; verifier: string }): Promise<client.IDToken>;
};

export async function createOidc(config: Config): Promise<Oidc> {
  const insecure = config.oidc.issuer.protocol === 'http:';
  const conf = await client.discovery(config.oidc.issuer, config.oidc.clientId, config.oidc.clientSecret,
    client.ClientSecretBasic(config.oidc.clientSecret), insecure ? { execute: [client.allowInsecureRequests] } : undefined);
  const redirectUri = new URL('/auth/callback', config.publicUrl).href;
  return {
    authorizationUrl: ({ state, nonce, challenge, loginHint }) => client.buildAuthorizationUrl(conf, {
      redirect_uri: redirectUri, scope: 'openid profile email', state, nonce,
      code_challenge: challenge, code_challenge_method: 'S256', ...(loginHint ? { login_hint: loginHint } : {}),
    }),
    async exchange(callbackUrl, { state, nonce, verifier }) {
      const tokens = await client.authorizationCodeGrant(conf, callbackUrl,
        { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true });
      const claims = tokens.claims();
      if (!claims) throw new Error('no id_token claims');
      return claims;
    },
  };
}
export const randomState = client.randomState;
export const randomNonce = client.randomNonce;
export const randomVerifier = client.randomPKCECodeVerifier;
export const challengeFor = client.calculatePKCECodeChallenge;
