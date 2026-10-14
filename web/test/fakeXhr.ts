type Result = { status: number; text: string } | 'abort' | 'timeout' | 'error';
type Handler = (url: string, body: unknown) => Result | Promise<Result>;

/** Minimal XMLHttpRequest stand-in: answers PUTs through `handler` on a microtask. */
export function installFakeXhr(handler: Handler): { puts: { url: string; body: unknown }[] } {
  const puts: { url: string; body: unknown }[] = [];
  class FakeXhr {
    status = 0; responseText = '';
    upload: { onprogress: unknown } = { onprogress: null };
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    onabort: (() => void) | null = null; ontimeout: (() => void) | null = null;
    private url = '';
    open(_m: string, url: string) { this.url = url; }
    setRequestHeader() {}
    send(body: unknown) {
      puts.push({ url: this.url, body });
      void Promise.resolve(handler(this.url, body)).then((r) => {
        if (r === 'abort') this.onabort?.();
        else if (r === 'timeout') this.ontimeout?.();
        else if (r === 'error') this.onerror?.();
        else { this.status = r.status; this.responseText = r.text; this.onload?.(); }
      });
    }
  }
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
  return { puts };
}
