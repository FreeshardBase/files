import { DOMParser, type Element } from '@xmldom/xmldom';
import type { TestApp } from './harness.ts';

const ORIGIN = 'https://files.example.com';

/** Creates an app password for the signed-in member through the API and answers it (shown once). */
export async function createAppPassword(t: TestApp, s: { cookie: string; csrf: string }, label = 'Test laptop'): Promise<string> {
  const r = await t.app.inject({ method: 'POST', url: '/api/v1/app-passwords',
    headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN }, payload: { label } });
  if (r.statusCode !== 201) throw new Error(`app password ${r.statusCode} ${r.body}`);
  return r.json().password as string;
}

export const basic = (password: string, user = 'testuser') => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

export type DavResponse = { href: string; status: string; props: Map<string, { status: string; el: Element }> };

/** A 207 multistatus body: one entry per `D:response`, its properties by `{namespace}name` with their propstat status. */
export function multistatus(body: string): DavResponse[] {
  const doc = new DOMParser().parseFromString(body, 'application/xml');
  const out: DavResponse[] = [];
  const responses = doc.getElementsByTagNameNS('DAV:', 'response');
  for (let i = 0; i < responses.length; i++) {
    const r = responses.item(i)!;
    const href = r.getElementsByTagNameNS('DAV:', 'href').item(0)!.textContent ?? '';
    const props = new Map<string, { status: string; el: Element }>();
    let status = '';
    for (let c = r.firstChild; c; c = c.nextSibling) {
      const el = c as Element;
      if (el.nodeType !== 1) continue;
      if (el.localName === 'status') status = el.textContent ?? '';
      if (el.localName !== 'propstat') continue;
      const st = el.getElementsByTagNameNS('DAV:', 'status').item(0)!.textContent ?? '';
      const prop = el.getElementsByTagNameNS('DAV:', 'prop').item(0)!;
      for (let p = prop.firstChild; p; p = p.nextSibling) {
        if (p.nodeType === 1) props.set(`{${(p as Element).namespaceURI ?? ''}}${(p as Element).localName}`, { status: st, el: p as Element });
      }
    }
    out.push({ href, status, props });
  }
  return out;
}

export const propText = (r: DavResponse | undefined, name: string): string | undefined => r?.props.get(`{DAV:}${name}`)?.el.textContent ?? undefined;
