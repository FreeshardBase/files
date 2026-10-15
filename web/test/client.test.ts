import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiFailure, rawRequest, sendXhr, setCsrf } from '../src/api/client.ts';
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
  it('sendXhr: abort and timeout are NETWORK, an error body carries code and params, a bare 423 is UPLOAD_LOCKED', async () => {
    const blob = new Blob(['x']);
    const send = () => sendXhr('PATCH', '/p', { 'upload-offset': '0' }, blob).done;
    const x = installFakeXhr(() => ({ status: 204, text: '', headers: { 'Upload-Offset': '1' } }));
    expect((await send()).header('upload-offset')).toBe('1');
    expect(x.puts[0]!.headers).toMatchObject({ 'upload-offset': '0', 'x-csrf-token': expect.any(String) });
    installFakeXhr(() => 'abort');
    await expect(send()).rejects.toMatchObject({ code: 'NETWORK' });
    installFakeXhr(() => 'timeout');
    await expect(send()).rejects.toMatchObject({ code: 'NETWORK' });
    installFakeXhr(() => ({ status: 409, text: '{"code":"FILE_EXISTS","params":{"name":"a"}}' }));
    await expect(send()).rejects.toMatchObject({ code: 'FILE_EXISTS', params: { name: 'a' } });
    installFakeXhr(() => ({ status: 423, text: '' }));
    await expect(send()).rejects.toMatchObject({ code: 'UPLOAD_LOCKED' });
    installFakeXhr(() => ({ status: 500, text: '{}' }));
    await expect(send()).rejects.toMatchObject({ code: 'INTERNAL' });
  });
  it('rawRequest: a HEAD 404 without body is NOT_FOUND, the CSRF token goes only on mutating methods', async () => {
    const f = vi.fn(async (_u: string, init?: RequestInit) => new Response(null, { status: init?.method === 'HEAD' ? 404 : 204 }));
    vi.stubGlobal('fetch', f);
    setCsrf('tok');
    await expect(rawRequest('HEAD', '/u', {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await rawRequest('DELETE', '/u', {});
    expect((f.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty('x-csrf-token');
    expect((f.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ 'x-csrf-token': 'tok' });
  });
});
