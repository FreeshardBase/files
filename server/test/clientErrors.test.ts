import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { login, startTestApp, type TestApp } from './support/harness.ts';

// Browser errors reported by the web app (#298): members only, logged at warn with the member's id, never verbatim
// paths or tokens, and at most 20 per session and minute.
let t: TestApp;
let lines: Record<string, unknown>[];

beforeEach(async () => {
  lines = [];
  const logStream = new PassThrough();
  logStream.on('data', (c: Buffer) => lines.push(...c.toString().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)));
  t = await startTestApp({ FILES_LOG_LEVEL: 'warn' }, undefined, logStream);
});
afterEach(async () => { await t.close(); });

const reports = () => lines.filter((l) => l.msg === 'client error');
const report = { message: 'TypeError: x is undefined', stack: 'TypeError: x is undefined\n    at render (https://files.example.com/assets/index-Ab12Cd34.js:1:200)',
  route: 'folder', build: 'index-Ab12Cd34.js', userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0' };

async function post(s: { cookie: string; csrf: string }, body: unknown) {
  return t.app.inject({ method: 'POST', url: '/api/v1/client-errors', payload: body as object,
    headers: { cookie: s.cookie, origin: t.config.publicUrl.origin, 'x-csrf-token': s.csrf } });
}

describe('POST /api/v1/client-errors', () => {
  it('answers 401 without a session and logs nothing', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/client-errors', payload: report,
      headers: { origin: t.config.publicUrl.origin } });
    expect(res.statusCode).toBe(401);
    expect(reports()).toHaveLength(0);
  });

  it('logs a report at warn with the member internal id and the reported fields', async () => {
    const s = await login(t);
    const res = await post(s, report);
    expect(res.statusCode).toBe(204);
    const user = t.db.prepare('SELECT id FROM users WHERE sub = ?').get('testuser') as { id: unknown };
    const [line] = reports();
    expect(line).toMatchObject({ level: 40, userId: user.id,
      clientError: { message: report.message, stack: report.stack, route: 'folder', build: report.build, userAgent: report.userAgent } });
    expect(reports()).toHaveLength(1);
  });

  it('logs at most 20 reports per session and minute, then answers 204 without a log line', async () => {
    const s = await login(t);
    for (let i = 0; i < 25; i++) expect((await post(s, { ...report, message: `boom ${i}` })).statusCode).toBe(204);
    expect(reports().map((l) => (l.clientError as { message: string }).message)).toEqual(Array.from({ length: 20 }, (_, i) => `boom ${i}`));
    // Another session of its own has its own allowance.
    const other = await login(t, 'member');
    expect((await post(other, report)).statusCode).toBe(204);
    expect(reports()).toHaveLength(21);
  });

  it('redacts paths, query strings and tokens before logging', async () => {
    const s = await login(t);
    const token = 'Zx81kQ_p0aLm3NvB7yT2cR';
    const res = await post(s, { ...report,
      message: `Failed to fetch https://files.example.com/api/v1/sources/home/content/Taxes/2025/Payslip.pdf?download=1 for /s/${token}/info`,
      stack: `Error: /home/Private/Diary.txt not found\n    at load (https://files.example.com/assets/index-Ab12Cd34.js:1:9)\n    at x (https://files.example.com/conn:abc/Holiday/photo.jpg?sig=secret)`,
      route: 'folder' });
    expect(res.statusCode).toBe(204);
    const logged = JSON.stringify(reports()[0]);
    for (const leak of ['Taxes', 'Payslip', 'download=1', token, 'Private', 'Diary', 'Holiday', 'photo.jpg', 'sig=secret']) {
      expect(logged).not.toContain(leak);
    }
    // What helps to debug stays: the error, the asset frame and where it went.
    expect(logged).toContain('Failed to fetch https://files.example.com/');
    expect(logged).toContain('https://files.example.com/assets/index-Ab12Cd34.js:1:9');
  });

  it('trims a stack to 4 KiB and refuses a body that is not a report', async () => {
    const s = await login(t);
    expect((await post(s, { ...report, stack: 'x'.repeat(20_000) })).statusCode).toBe(204);
    expect(Buffer.byteLength((reports()[0]!.clientError as { stack: string }).stack)).toBeLessThanOrEqual(4096);
    expect((await post(s, { message: 42 })).statusCode).toBe(400);
  });
});
