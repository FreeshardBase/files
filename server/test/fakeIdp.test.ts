import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeIdp, type FakeIdp } from './support/fakeIdp.ts';

let idp: FakeIdp;
beforeAll(async () => { idp = await startFakeIdp(); });
afterAll(() => idp.close());

const redirect = 'http://127.0.0.1:1/cb';
const challenge = (v: string) => createHash('sha256').update(v).digest('base64url');
const authorize = (extra: Record<string, string> = {}, drop: string[] = []) => {
  const q = new URLSearchParams({ client_id: 'files', response_type: 'code', redirect_uri: redirect,
    code_challenge: challenge('v1'), code_challenge_method: 'S256', state: 's1', ...extra });
  drop.forEach((k) => q.delete(k));
  return fetch(`${idp.issuer}/authorize?${q}`, { redirect: 'manual' });
};
const basic = (secret: string) => `Basic ${Buffer.from(`files:${secret}`).toString('base64')}`;
const token = (code: string, verifier: string, secret = 'files-secret') => fetch(`${idp.issuer}/token`, {
  method: 'POST', headers: { authorization: basic(secret), 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect }),
});
const getCode = async () => new URL((await authorize()).headers.get('location')!).searchParams.get('code')!;

describe('fake IdP', () => {
  it('rejects /authorize without redirect_uri', async () => {
    expect((await authorize({}, ['redirect_uri'])).status).toBe(400);
  });

  it('rejects /authorize without state', async () => {
    expect((await authorize({}, ['state'])).status).toBe(400);
  });

  it('completes the happy path', async () => {
    expect((await token(await getCode(), 'v1')).status).toBe(200);
  });

  it('rejects a wrong client secret at /token', async () => {
    expect((await token(await getCode(), 'v1', 'wrong')).status).toBe(401);
  });

  it('rejects a wrong code_verifier', async () => {
    expect((await token(await getCode(), 'other')).status).toBe(400);
  });
});
