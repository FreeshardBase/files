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
  });

  it('refuses a short session secret', () => {
    expect(() => loadConfig({ ...valid, FILES_SESSION_SECRET: 'short' })).toThrow(/FILES_SESSION_SECRET/);
  });

  it('refuses an encryption key that is not 32 bytes', () => {
    expect(() => loadConfig({ ...valid, FILES_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/FILES_ENCRYPTION_KEY/);
  });

  it('refuses a plain-http issuer on a non-loopback host', () => {
    expect(() => loadConfig({ ...valid, FILES_OIDC_ISSUER: 'http://idp.example.com' })).toThrow(/FILES_OIDC_ISSUER/);
  });

  it('allows a plain-http issuer on 127.0.0.1', () => {
    expect(loadConfig({ ...valid, FILES_OIDC_ISSUER: 'http://127.0.0.1:4000' }).oidc.issuer.port).toBe('4000');
  });

  it('reports every problem at once', () => {
    try { loadConfig({}); throw new Error('no throw'); }
    catch (e) { expect((e as ConfigError).problems.length).toBeGreaterThanOrEqual(9); }
  });
});
