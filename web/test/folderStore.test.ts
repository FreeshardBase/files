import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useFolderStore } from '../src/stores/folder.ts';
import { installFakeXhr } from './fakeXhr.ts';

const entry = (i: number) => ({ name: `f${i}`, path: `/f${i}`, type: 'file', size: 1, modified: '2026-10-14T00:00:00.000Z' });

beforeEach(() => setActivePinia(createPinia()));

describe('folder store', () => {
  it('follows next until the full listing is loaded', async () => {
    const pages: Record<string, unknown> = {
      '': { entries: [entry(1), entry(2)], next: 'c1' },
      c1: { entries: [entry(3)], next: 'c2' },
      c2: { entries: [entry(4)] },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const cursor = new URL(url, 'http://x').searchParams.get('cursor') ?? '';
      return new Response(JSON.stringify(pages[cursor]), { status: 200 });
    }));
    const s = useFolderStore();
    await s.open('/');
    expect(s.entries.map((e) => e.name)).toEqual(['f1', 'f2', 'f3', 'f4']);
  });
  it('keeps the error and clears loading when listing fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404 })));
    const s = useFolderStore();
    await s.open('/gone');
    expect(s.loading).toBe(false);
    expect(s.error?.code).toBe('NOT_FOUND');
  });
});

describe('folder store writes', () => {
  const calls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
  it('mkdir posts the joined path and relists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ entries: [] }), { status: 200 })));
    const s = useFolderStore();
    await s.open('/Fotos');
    await s.mkdir('neu');
    const post = calls().find(([, i]) => i.method === 'POST')!;
    expect(post[0]).toBe('/api/v1/sources/home/mkdir');
    expect(JSON.parse(post[1].body as string)).toEqual({ path: '/Fotos/neu' });
    expect(calls().filter(([, i]) => i.method === 'GET')).toHaveLength(2);
  });
  it('mkdir in the root does not produce a double slash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ entries: [] }), { status: 200 })));
    const s = useFolderStore();
    await s.open('/');
    await s.mkdir('neu');
    const post = calls().find(([, i]) => i.method === 'POST')!;
    expect(JSON.parse(post[1].body as string)).toEqual({ path: '/neu' });
  });
});

describe('folder store races and upload target', () => {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  it('a slow failing listing cannot clobber a newer successful one', async () => {
    let failFirst!: () => void;
    const first = new Promise<Response>((res) => { failFirst = () => res(json({ code: 'INTERNAL' }, 500)); });
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      new URL(url, 'http://x').searchParams.get('path') === '/slow' ? first : Promise.resolve(json({ entries: [entry(9)] }))));
    const s = useFolderStore();
    const p1 = s.open('/slow');
    const p2 = s.open('/fast');
    await p2;
    expect(s.entries.map((e) => e.name)).toEqual(['f9']);
    expect(s.loading).toBe(false);
    failFirst();
    await p1;
    expect(s.error).toBeNull();
    expect(s.entries.map((e) => e.name)).toEqual(['f9']);
    expect(s.path).toBe('/fast');
  });
  it('loading stays true until the newest request settles', async () => {
    let finishSecond!: () => void;
    const second = new Promise<Response>((res) => { finishSecond = () => res(json({ entries: [] })); });
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      new URL(url, 'http://x').searchParams.get('path') === '/b' ? second : Promise.resolve(json({ entries: [] }))));
    const s = useFolderStore();
    const p2pre = s.open('/a');
    const p2 = s.open('/b');
    await p2pre;
    expect(s.loading).toBe(true);
    finishSecond();
    await p2;
    expect(s.loading).toBe(false);
  });
  it('refresh keeps the entries visible and sets refreshing, not loading', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { if (++n === 2) await gate; return json({ entries: [entry(1)] }); }));
    const s = useFolderStore();
    await s.open('/');
    const p = s.open('/', { refresh: true });
    expect(s.loading).toBe(false);
    expect(s.refreshing).toBe(true);
    expect(s.entries).toHaveLength(1);
    release();
    await p;
    expect(s.refreshing).toBe(false);
  });
  it('upload joins with the given dir even after the store path moved', async () => {
    const x = installFakeXhr(() => ({ status: 201, text: JSON.stringify(entry(1)) }));
    vi.stubGlobal('fetch', vi.fn(async () => json({ entries: [] })));
    const s = useFolderStore();
    await s.open('/A');
    await s.open('/B');
    await s.upload(new File(['x'], 'n.txt'), '/A');
    expect(new URL(x.puts[0]!.url, 'http://x').searchParams.get('path')).toBe('/A/n.txt');
  });
});
