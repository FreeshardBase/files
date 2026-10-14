import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiFailure, setCsrf } from '../src/api/client.ts';

afterEach(() => vi.restoreAllMocks());

describe('api client', () => {
  it('redirects to login on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'UNAUTHENTICATED' }), { status: 401 })));
    const loc = { href: 'http://x/Fotos', pathname: '/Fotos', search: '' };
    vi.stubGlobal('location', loc);
    await expect(api.get('/api/v1/me')).rejects.toBeInstanceOf(ApiFailure);
    expect(loc.href).toBe('/auth/login?returnTo=%2FFotos');
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
