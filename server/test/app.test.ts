import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from './support/harness.ts';
import { AppError } from '../src/errors.ts';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp({}, (app) => {
    app.get('/__boom', { config: { public: true } }, async () => { throw new Error('secret detail'); });
    app.post('/__post', { config: { public: true } }, async () => ({ ok: true }));
    app.get('/__exists', { config: { public: true } }, async () => { throw new AppError('FILE_EXISTS', { name: 'a.txt' }); });
  });
});
afterAll(() => t.close());

describe('app', () => {
  it('serves /healthz without auth', async () => {
    const r = await t.app.inject('/healthz');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok' });
  });

  it('sets security headers', async () => {
    const r = await t.app.inject('/healthz');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('maps AppError to code + params', async () => {
    const r = await t.app.inject('/__exists');
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ code: 'FILE_EXISTS', params: { name: 'a.txt' } });
  });

  it('hides internal error details from the client', async () => {
    const r = await t.app.inject('/__boom');
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ code: 'INTERNAL' });
    expect(r.body).not.toContain('secret detail');
  });

  it('keeps malformed JSON a 400 VALIDATION, not a 500', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/__post', headers: { 'content-type': 'application/json' }, payload: '{bad' });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ code: 'VALIDATION' });
  });

  it('keeps an unsupported content type a 415 VALIDATION, not a 500', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/__post', headers: { 'content-type': 'application/xml' }, payload: '<x/>' });
    expect(r.statusCode).toBe(415);
    expect(r.json()).toEqual({ code: 'VALIDATION' });
  });

  it('does not log the query string', async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    const l = await startTestApp({ FILES_LOG_LEVEL: 'info' }, undefined, stream);
    try {
      await l.app.inject('/healthz?token=SECRET123');
    } finally { await l.close(); }
    const out = lines.join('');
    expect(out).toContain('/healthz');
    expect(out).not.toContain('SECRET123');
  });
});
