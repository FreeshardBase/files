import type { Readable } from 'node:stream';
import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import { AppError } from '../errors.ts';

// XML of WebDAV request and response bodies (#157). Request bodies are small (PROPFIND, PROPPATCH, LOCK), so they are
// read up to a cap and parsed; a DOCTYPE is refused outright, so no entity is ever declared or expanded.

export const DAV = 'DAV:';
const MAX_XML_BYTES = 1024 * 1024;

/** The body as text, at most 1 MiB (VALIDATION beyond); decoded as it arrives, never collected as buffers. */
export async function readText(body: Readable | undefined): Promise<string> {
  if (!body) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = ''; let bytes = 0;
  try {
    for await (const chunk of body) {
      bytes += (chunk as Buffer).length;
      if (bytes > MAX_XML_BYTES) throw new AppError('PAYLOAD_TOO_LARGE');
      text += decoder.decode(chunk as Buffer, { stream: true });
    }
    return text + decoder.decode();
  } catch (e) {
    if (e instanceof TypeError) throw new AppError('VALIDATION', undefined, { cause: e }); // not UTF-8
    throw e;
  }
}

/** The parsed document, or undefined for an empty body. Malformed XML, a DOCTYPE or an unbound prefix are VALIDATION. */
export function parseXml(text: string): Document | undefined {
  if (text.trim() === '') return undefined;
  if (/<!DOCTYPE/i.test(text)) throw new AppError('VALIDATION');
  let doc: Document;
  try {
    doc = new DOMParser({ onError: (level, message) => { if (level !== 'warning') throw new Error(message); } })
      .parseFromString(text, 'application/xml');
  } catch (e) {
    throw new AppError('VALIDATION', undefined, { cause: e });
  }
  const check = (el: Element) => {
    if (el.prefix && !el.namespaceURI) throw new AppError('VALIDATION'); // a prefix bound to nothing (or to "")
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes.item(i)!;
      if (a.prefix === 'xmlns' && a.value === '') throw new AppError('VALIDATION'); // xmlns:p="" is not allowed in XML 1.0
    }
    for (const c of children(el)) check(c);
  };
  if (!doc.documentElement) throw new AppError('VALIDATION');
  check(doc.documentElement);
  return doc;
}

export const children = (el: Element): Element[] => {
  const out: Element[] = [];
  for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c as Element);
  return out;
};
export const isDav = (el: Element, name: string): boolean => el.namespaceURI === DAV && el.localName === name;
export const child = (el: Element, name: string): Element | undefined => children(el).find((c) => isDav(c, name));

/** The element as standalone XML: every namespace it uses is declared on it. */
export const serialize = (el: Element): string => new XMLSerializer().serializeToString(el);

export const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A property name: its namespace (`''` for none) and local name. */
export type PropName = { ns: string; name: string };
export const propKey = (p: PropName): string => `{${p.ns}}${p.name}`;
export const propNameOf = (el: Element): PropName => ({ ns: el.namespaceURI ?? '', name: el.localName! });

/** An element for a property name; DAV: properties use the response's `D:` prefix, others declare their own. */
export function propElement(p: PropName, inner = ''): string {
  if (p.ns === DAV) return inner ? `<D:${p.name}>${inner}</D:${p.name}>` : `<D:${p.name}/>`;
  const open = p.ns === '' ? `${p.name} xmlns=""` : `X:${p.name} xmlns:X="${escapeXml(p.ns)}"`;
  const close = p.ns === '' ? p.name : `X:${p.name}`;
  return inner ? `<${open}>${inner}</${close}>` : `<${open}/>`;
}

export const STATUS: Record<number, string> = {
  200: 'HTTP/1.1 200 OK', 403: 'HTTP/1.1 403 Forbidden', 404: 'HTTP/1.1 404 Not Found', 424: 'HTTP/1.1 424 Failed Dependency',
  507: 'HTTP/1.1 507 Insufficient Storage',
};

export const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n';
