import { hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.ts';

const valid = {
  FILES_PUBLIC_URL: 'https://files.example.com',
  FILES_DATA_DIR: '/tmp/files-test',
  FILES_SESSION_SECRET: 'x'.repeat(48),
  FILES_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  FILES_OIDC_ISSUER: 'https://idp.example.com',
  FILES_OIDC_CLIENT_ID: 'files',
  FILES_OIDC_CLIENT_SECRET: 'secret',
  FILES_OIDC_ROLE_CLAIM: 'groups',
  FILES_OIDC_ADMIN_VALUE: 'admin',
};

function thrownBy(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; } // handled: the caller asserts on the returned error
  return undefined;
}

describe('loadConfig', () => {
  it('accepts a complete production config', () => {
    const c = loadConfig({ ...valid, NODE_ENV: 'production' });
    expect(c.publicUrl.origin).toBe('https://files.example.com');
    expect(c.encryptionKey.length).toBe(32);
    expect(c.maxUploadBytes).toBe(10 * 1024 ** 3);
  });

  it.each(Object.keys(valid))('refuses to start without %s', (key) => {
    const env: Record<string, string> = { ...valid };
    delete env[key];
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(new RegExp(key));
  });

  it('derives the ETag key from the session secret, never the secret itself (#279)', () => {
    const a = loadConfig(valid).etagKey;
    const b = loadConfig({ ...valid, FILES_SESSION_SECRET: 'y'.repeat(48) }).etagKey;
    expect(a).toBeInstanceOf(Buffer);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(false);
    expect(a.equals(loadConfig(valid).etagKey)).toBe(true);
    expect(a.includes(Buffer.from(valid.FILES_SESSION_SECRET))).toBe(false);
    expect(a.equals(loadConfig(valid).encryptionKey)).toBe(false);
  });

  it('refuses a short session secret', () => {
    expect(() => loadConfig({ ...valid, FILES_SESSION_SECRET: 'short' })).toThrow(/FILES_SESSION_SECRET/);
  });

  // The shard's app template can only produce `{{ secret('…') }}`: 32 characters of [A-Za-z0-9].
  const shardSecret = 'Ab3dEf6hIj9lMn2pQr5tUv8xYz1BcD4F';

  it('accepts a 32-character shard secret and derives a 32-byte key from it', () => {
    expect(shardSecret).toHaveLength(32);
    const key = loadConfig({ ...valid, FILES_ENCRYPTION_KEY: shardSecret }).encryptionKey;
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    expect(key.equals(Buffer.from(shardSecret))).toBe(false);
  });

  it('refuses an encryption key shorter than 32 characters', () => {
    const err = thrownBy(() => loadConfig({ ...valid, FILES_ENCRYPTION_KEY: shardSecret.slice(0, 31) }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).problems).toEqual([expect.stringMatching(/^FILES_ENCRYPTION_KEY: .*32/)]);
  });

  it('derives the same key for the same secret and different keys for different secrets', () => {
    const derive = (secret: string) => loadConfig({ ...valid, FILES_ENCRYPTION_KEY: secret }).encryptionKey;
    expect(derive(shardSecret).equals(derive(shardSecret))).toBe(true);
    expect(derive(shardSecret).equals(derive(shardSecret.replace('A', 'B')))).toBe(false);
    expect(derive(shardSecret).equals(derive(shardSecret + 'x'))).toBe(false);
  });

  it('derives the key with HKDF-SHA256 using the documented salt and info', () => {
    const expected = Buffer.from(hkdfSync('sha256', shardSecret, 'freeshard-files', 'files/encryption-key/v1', 32));
    expect(loadConfig({ ...valid, FILES_ENCRYPTION_KEY: shardSecret }).encryptionKey.equals(expected)).toBe(true);
  });

  it('refuses a plain-http issuer on a non-loopback host', () => {
    expect(() => loadConfig({ ...valid, FILES_OIDC_ISSUER: 'http://idp.example.com' })).toThrow(/FILES_OIDC_ISSUER/);
  });

  it('allows a plain-http issuer on 127.0.0.1', () => {
    expect(loadConfig({ ...valid, FILES_OIDC_ISSUER: 'http://127.0.0.1:4000' }).oidc.issuer.port).toBe('4000');
  });

  it('reports every problem at once', () => {
    const err = thrownBy(() => loadConfig({}));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).problems.length).toBeGreaterThanOrEqual(7);
  });

  // shard_core's OIDC provider sends no role claim yet (freeshard#251), so the app template cannot set these.
  it('accepts a config without FILES_OIDC_ROLE_CLAIM and FILES_OIDC_ADMIN_VALUE and maps nobody to admin', () => {
    const env: Record<string, string> = { ...valid };
    delete env.FILES_OIDC_ROLE_CLAIM;
    delete env.FILES_OIDC_ADMIN_VALUE;
    expect(loadConfig(env).oidc.admin).toBeUndefined();
  });

  it('exposes the admin claim mapping when both are set', () => {
    expect(loadConfig(valid).oidc.admin).toEqual({ claim: 'groups', value: 'admin' });
  });

  it.each(['FILES_OIDC_ROLE_CLAIM', 'FILES_OIDC_ADMIN_VALUE'])('refuses to start with only one of the pair (without %s)', (key) => {
    const env: Record<string, string> = { ...valid };
    delete env[key];
    const err = thrownBy(() => loadConfig(env));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).problems).toEqual([expect.stringMatching(/FILES_OIDC_ROLE_CLAIM.*FILES_OIDC_ADMIN_VALUE.*both or neither/)]);
  });

  it.each([
    ['http://files.example.com'], ['ftp://files.example.com'], ['https://files.example.com/sub'],
    ['https://files.example.com/?x=1'], ['https://files.example.com/#frag'], ['http://10.0.0.5:3005'],
  ])('refuses FILES_PUBLIC_URL %s', (url) => {
    expect(() => loadConfig({ ...valid, FILES_PUBLIC_URL: url })).toThrow(/FILES_PUBLIC_URL/);
  });

  it.each([['https://files.example.com'], ['https://files.example.com/'], ['http://localhost:3005'], ['http://127.0.0.1:3005'], ['http://[::1]:3005']])(
    'accepts FILES_PUBLIC_URL %s', (url) => {
      expect(loadConfig({ ...valid, FILES_PUBLIC_URL: url }).publicUrl.href).toBe(new URL(url).href);
    });
});
