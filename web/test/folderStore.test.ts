import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useFolderStore } from '../src/stores/folder.ts';

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
