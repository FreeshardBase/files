import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '../src/router.ts';
import { setCsrf } from '../src/api/client.ts';
import { installErrorReporting } from '../src/errorReporting.ts';

// Browser errors go to the server (#298): one report per error, with the route's name instead of its path.
const SECRET_PATH = '/home/Secret%20Folder/Taxes.pdf';
let uninstall: (() => void) | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

async function routerAt(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  return router;
}

const boom = (): string => { throw new Error('render boom'); };
const Broken = defineComponent({ render: () => h('p', boom()) });

const sent = () => fetchMock.mock.calls.map(([url, init]) => ({ url, init: init as RequestInit, body: JSON.parse(String((init as RequestInit).body)) as Record<string, string> }));

beforeEach(() => {
  setCsrf('tok');
  history.replaceState(null, '', `${SECRET_PATH}?q=private`);
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { uninstall?.(); uninstall = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); setCsrf(''); });

function expectOneReport(message: string) {
  expect(sent()).toHaveLength(1);
  const [{ url, init, body }] = sent() as [ReturnType<typeof sent>[number]];
  expect(url).toBe('/api/v1/client-errors');
  expect(init.method).toBe('POST');
  expect(init.headers).toMatchObject({ 'x-csrf-token': 'tok', 'content-type': 'application/json' });
  expect(body.message).toContain(message);
  expect(body.stack).toEqual(expect.any(String));
  expect(body.route).toBe('folder');
  expect(body.build).toEqual(expect.stringMatching(/\S/));
  expect(body.userAgent).toBe(navigator.userAgent);
  const raw = String(init.body);
  for (const leak of ['Secret', 'Taxes', 'private']) expect(raw).not.toContain(leak);
}

describe('client error reporting', () => {
  it('reports a Vue render error once, with the route name and without the path', async () => {
    const router = await routerAt(`${SECRET_PATH}?q=private`);
    const app = createApp(Broken).use(router);
    uninstall = installErrorReporting(app, router);
    app.mount(document.createElement('div'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expectOneReport('render boom');
    app.unmount();
  });

  it('reports an unhandled promise rejection once', async () => {
    const router = await routerAt(`${SECRET_PATH}?q=private`);
    uninstall = installErrorReporting(createApp(Broken), router);
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('async boom') }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expectOneReport('async boom');
  });

  it('reports an uncaught error once', async () => {
    const router = await routerAt(`${SECRET_PATH}?q=private`);
    uninstall = installErrorReporting(createApp(Broken), router);
    const error = new Error('uncaught boom');
    window.dispatchEvent(Object.assign(new Event('error'), { error, message: error.message }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expectOneReport('uncaught boom');
  });

  it('drops a report that fails, and never reports its own failure', async () => {
    const router = await routerAt('/recent');
    uninstall = installErrorReporting(createApp(Broken), router);
    fetchMock.mockImplementation(() => { throw new TypeError('fetch broke'); });
    expect(() => window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('first') }))).not.toThrow();
    fetchMock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'second' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends nothing without a signed-in member (a public link page)', async () => {
    setCsrf('');
    const router = await routerAt('/recent');
    uninstall = installErrorReporting(createApp(Broken), router);
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('visitor') }));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
