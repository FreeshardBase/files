import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

type User = { name: string; email: string; groups: string[] };
export type FakeIdp = { issuer: string; close(): Promise<void> };

const DEFAULT_USERS: Record<string, User> = {
  testuser: { name: 'Test User', email: 'testuser@example.com', groups: ['admin'] },
  member: { name: 'Test Member', email: 'member@example.com', groups: [] },
};

export async function startFakeIdp(opts: { port?: number; users?: Record<string, User>;
  clientId?: string; clientSecret?: string } = {}): Promise<FakeIdp> {
  const users = opts.users ?? DEFAULT_USERS;
  const clientId = opts.clientId ?? 'files';
  const clientSecret = opts.clientSecret ?? 'files-secret';
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  const codes = new Map<string, { redirectUri: string; nonce: string; challenge: string; sub: string }>();
  let issuer = '';

  const json = (res: http.ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'],
        subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['ES256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      const sub = p.get('login_hint') ?? 'testuser';
      if (p.get('client_id') !== clientId || p.get('code_challenge_method') !== 'S256' || !users[sub]) {
        return json(res, 400, { error: 'invalid_request' });
      }
      const code = randomBytes(16).toString('hex');
      codes.set(code, { redirectUri: p.get('redirect_uri')!, nonce: p.get('nonce') ?? '',
        challenge: p.get('code_challenge')!, sub });
      const back = new URL(p.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state') ?? '');
      back.searchParams.set('iss', issuer);
      res.writeHead(302, { location: back.href }).end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => { body += c; });
      req.on('end', async () => {
        const form = new URLSearchParams(body);
        const auth = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
        const [id, secret] = auth.split(':').map(decodeURIComponent);
        const entry = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifierHash = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (id !== clientId || secret !== clientSecret || !entry || entry.challenge !== verifierHash
            || entry.redirectUri !== form.get('redirect_uri')) {
          return json(res, 400, { error: 'invalid_grant' });
        }
        const u = users[entry.sub]!;
        const idToken = await new SignJWT({ nonce: entry.nonce, name: u.name, email: u.email, groups: u.groups })
          .setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(issuer).setAudience(clientId)
          .setSubject(entry.sub).setIssuedAt().setExpirationTime('5m').sign(privateKey);
        json(res, 200, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken });
      });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { issuer, close: () => new Promise((r) => server.close(() => r())) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FAKE_IDP_PORT ?? 4000);
  startFakeIdp({ port }).then((i) => console.log(`fake IdP at ${i.issuer}`));
}
