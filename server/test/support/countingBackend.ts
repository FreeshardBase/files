import type { Entry } from '@files/shared';
import { MemBackend } from './memBackend.ts';

/**
 * A memory backend whose `stat` counts the calls in flight (#307): each one yields to the event loop before it answers,
 * so calls started together overlap; `peak` is the most that were ever in flight at once, `stats` how many were made.
 */
export class CountingBackend extends MemBackend {
  inFlight = 0;
  peak = 0;
  stats = 0;
  /** With a value, each `stat` waits this long instead (a slow provider). */
  delayMs: number | undefined;

  reset(): void { this.peak = 0; this.stats = 0; }

  override async stat(path: string): Promise<Entry> {
    this.stats++;
    this.peak = Math.max(this.peak, ++this.inFlight);
    try {
      await new Promise((r) => (this.delayMs === undefined ? setImmediate(r) : setTimeout(r, this.delayMs)));
      return await super.stat(path);
    } finally { this.inFlight--; }
  }
}
