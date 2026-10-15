/**
 * Counts failed attempts per key in a fixed window that starts with the first failure. Once `max` failures are in, the
 * key is blocked until the window ends, whatever is tried meanwhile, a correct password included. In memory: the app
 * runs as one process, and a restart only gives an attacker one more window.
 */
export class AttemptLimiter {
  private entries = new Map<string, { failures: number; resetAt: number }>();
  constructor(private max: number, private windowMs: number) {}

  /** Seconds until the key may try again, or 0 if it may try now. */
  blockedFor(key: string, now = Date.now()): number {
    const e = this.entries.get(key);
    if (!e || e.resetAt <= now) return 0;
    return e.failures >= this.max ? Math.ceil((e.resetAt - now) / 1000) : 0;
  }

  fail(key: string, now = Date.now()): void {
    this.prune(now);
    const e = this.entries.get(key);
    if (!e || e.resetAt <= now) this.entries.set(key, { failures: 1, resetAt: now + this.windowMs });
    else e.failures++;
  }

  // Drops ended windows, so the map holds only keys that failed within the last window.
  private prune(now: number): void {
    if (this.entries.size < 1024) return;
    for (const [k, e] of this.entries) if (e.resetAt <= now) this.entries.delete(k);
  }
}
