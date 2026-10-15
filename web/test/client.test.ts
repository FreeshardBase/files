import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiFailure, setCsrf } from '../src/api/client.ts';
import { installFakeXhr } from './fakeXhr.ts';

afterEach(() => vi.restoreAllMocks());

describe('api client', () => {
  it('redirects to login on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'UNAUTHENTICATED' }), { status: 401 })));
    const loc = { href: 'http://x/Fotos', pathname: '/Fotos', search: '' };
    vi.stubGlobal('location', loc);
    await expect(api.get('/api/v1/me')).rejects.toBeInstanceOf(ApiFailure);
    expect(loc.href).toBe('/auth/login?returnTo=%2FFotos');
  });
  it('does not redirect to login again while a failed login is being shown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'UNAUTHENTICATED' }), { status: 401 })));
    const loc = { href: 'http://x/home?loginError=1', pathname: '/home', search: '?loginError=1' };
    vi.stubGlobal('location', loc);
    await expect(api.get('/api/v1/me')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(loc.href).toBe('http://x/home?loginError=1');
  });
  it('sends the CSRF token on mutating requests', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', f);
    setCsrf('tok');
    await api.post('/api/v1/sources/home/mkdir', { path: '/a' });
    expect((f.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'x-csrf-token': 'tok' });
  });
  it('turns a network error into code NETWORK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(api.get('/api/v1/me')).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

describe('api client robustness', () => {
  it('rejects a 2xx whose body is not JSON with INTERNAL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })));
    await expect(api.get('/api/v1/me')).rejects.toMatchObject({ code: 'INTERNAL' });
  });
  it('maps an error JSON without code to INTERNAL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"x"}', { status: 500 })));
    await expect(api.get('/api/v1/me')).rejects.toMatchObject({ code: 'INTERNAL' });
  });
  it('put: 2xx non-JSON is INTERNAL, abort and timeout are NETWORK, 409 carries code and params', async () => {
    const blob = new Blob(['x']);
    installFakeXhr(() => ({ status: 201, text: 'ok' }));
    await expect(api.put('/p', {}, blob)).rejects.toMatchObject({ code: 'INTERNAL' });
    installFakeXhr(() => 'abort');
    await expect(api.put('/p', {}, blob)).rejects.toMatchObject({ code: 'NETWORK' });
    installFakeXhr(() => 'timeout');
    await expect(api.put('/p', {}, blob)).rejects.toMatchObject({ code: 'NETWORK' });
    installFakeXhr(() => ({ status: 409, text: '{"code":"FILE_EXISTS","params":{"name":"a"}}' }));
    await expect(api.put('/p', {}, blob)).rejects.toMatchObject({ code: 'FILE_EXISTS', params: { name: 'a' } });
    installFakeXhr(() => ({ status: 500, text: '{}' }));
    await expect(api.put('/p', {}, blob)).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
