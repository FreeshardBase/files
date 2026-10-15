type Result = { status: number; text: string; headers?: Record<string, string> } | 'abort' | 'timeout' | 'error';
export type XhrRequest = { url: string; body: unknown; method: string; headers: Record<string, string> };
type Handler = (url: string, body: unknown, req: XhrRequest) => Result | Promise<Result>;

/** Minimal XMLHttpRequest stand-in: answers requests through `handler` on a microtask; `abort()` ends it at once. */
export function installFakeXhr(handler: Handler): { puts: XhrRequest[] } {
  const puts: XhrRequest[] = [];
  class FakeXhr {
    status = 0; responseText = '';
    upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    onabort: (() => void) | null = null; ontimeout: (() => void) | null = null;
    private url = ''; private method = ''; private headers: Record<string, string> = {};
    private responseHeaders: Record<string, string> = {};
    private finished = false;
    open(m: string, url: string) { this.method = m; this.url = url; }
    setRequestHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
    getResponseHeader(n: string) { return this.responseHeaders[n.toLowerCase()] ?? null; }
    abort() { if (!this.finished) { this.finished = true; this.onabort?.(); } }
    send(body: unknown) {
      const req = { url: this.url, body, method: this.method, headers: this.headers };
      puts.push(req);
      void Promise.resolve(handler(this.url, body, req)).then((r) => {
        if (this.finished) return;
        this.finished = true;
        if (r === 'abort') this.onabort?.();
        else if (r === 'timeout') this.ontimeout?.();
        else if (r === 'error') this.onerror?.();
        else {
          if (body instanceof Blob) this.upload.onprogress?.({ loaded: body.size });
          this.status = r.status; this.responseText = r.text;
          this.responseHeaders = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
          this.onload?.();
        }
      });
    }
  }
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
  return { puts };
}
