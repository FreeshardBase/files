import { beforeEach, describe, expect, it } from 'vitest';
import { ResumableUpload } from '../src/api/tus.ts';
import { installFakeTus } from './fakeTus.ts';

const file = (size: number, name = 'a.bin') => new File([new Uint8Array(size)], name, { lastModified: 1_700_000_000_000 });
const target = { source: 'home', path: '/a.bin' };

beforeEach(() => localStorage.clear());

describe('ResumableUpload', () => {
  it('creates with the target and policy in the metadata and sends the bytes', async () => {
    const tus = installFakeTus();
    const sent: number[] = [];
    expect(await new ResumableUpload(file(10), target, (n) => sent.push(n)).run('keep-both')).toBe('done');
    expect(tus.log.created).toEqual(['/a.bin:keep-both']);
    expect(tus.log.placed).toEqual(['/a.bin:keep-both']);
    expect(sent.at(-1)).toBe(10);
    expect(localStorage.length).toBe(0);
  });

  it('after a reload, the same file continues with HEAD + PATCH from the server offset instead of starting over', async () => {
    let stall = true;
    const tus = installFakeTus({ onPatch: () => (stall ? { keep: 4, answer: new Promise(() => undefined) } : undefined) });
    const first = new ResumableUpload(file(10), target, () => undefined);
    const running = first.run('fail');
    await expect.poll(() => tus.log.patches.length).toBe(1);
    first.pause(); // the page goes away mid-PATCH; the server kept 4 bytes
    expect(await running).toBe('paused');
    stall = false;
    // A new page: a fresh object for the same file and target.
    const again = new ResumableUpload(file(10), target, () => undefined);
    expect(await again.run('fail')).toBe('done');
    expect(tus.log.created).toHaveLength(1);
    expect(tus.log.heads).toEqual(['u1']);
    expect(tus.log.patches).toEqual(['/a.bin@0', '/a.bin@4']);
    expect(tus.log.placed).toEqual(['/a.bin:fail']);
  });

  it('retries a dropped connection with HEAD and continues from what the server has', async () => {
    let drops = 1;
    const tus = installFakeTus({ onPatch: () => (drops-- > 0 ? { keep: 3, answer: 'error' } : undefined) });
    expect(await new ResumableUpload(file(10), target, () => undefined).run('fail')).toBe('done');
    expect(tus.log.heads).toEqual(['u1']);
    expect(tus.log.patches).toEqual(['/a.bin@0', '/a.bin@3']);
  });

  it('gives up with NETWORK after the retries', async () => {
    installFakeTus({ onCreate: () => 'error' });
    await expect(new ResumableUpload(file(10), target, () => undefined).run('fail')).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('a name taken at the end keeps the bytes: running again with another policy only places them', async () => {
    let taken = false;
    const tus = installFakeTus({ taken: () => taken, onPatch: () => { taken = true; return undefined; } });
    const up = new ResumableUpload(file(10), target, () => undefined);
    await expect(up.run('fail')).rejects.toMatchObject({ code: 'FILE_EXISTS', params: { name: 'a.bin' } });
    expect(await up.run('replace')).toBe('done');
    expect(tus.log.patches).toEqual(['/a.bin@0']);
    expect(tus.log.placed).toEqual(['/a.bin:replace']);
  });

  it('discard terminates the upload on the server and forgets it', async () => {
    const tus = installFakeTus({ onPatch: () => ({ keep: 5, answer: new Promise(() => undefined) }) });
    const up = new ResumableUpload(file(10), target, () => undefined);
    const running = up.run('fail');
    await expect.poll(() => tus.log.patches.length).toBe(1);
    await up.discard();
    expect(await running).toBe('paused');
    expect(tus.log.deleted).toEqual(['u1']);
    expect(tus.uploads.size).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it('places an empty file with one empty PATCH', async () => {
    const tus = installFakeTus();
    expect(await new ResumableUpload(file(0), target, () => undefined).run('fail')).toBe('done');
    expect(tus.log.patches).toEqual(['/a.bin@0']);
    expect(tus.log.placed).toEqual(['/a.bin:fail']);
  });
});
