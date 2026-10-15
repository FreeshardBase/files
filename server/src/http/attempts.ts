/**
 * Counts attempts per key in a fixed window that starts with the first attempt. An attempt is reserved with `begin` in
 * the same synchronous step as the check, counts while it is in flight, and is settled with `end`: a failure keeps its
 * place, a success gives it back (#196: otherwise a parallel burst passes the check before any guess is counted). Once
 * `max` failed or pending attempts are in, the key is blocked until the window ends, whatever is tried meanwhile, a
 * correct password included. In memory: the app runs as one process, and a restart only gives an attacker one more
 * window.
 */
export class AttemptLimiter {
  private entries = new Map<string, { failures: number; pending: number; resetAt: number }>();
  constructor(private max: number, private windowMs: number) {}

  /** Seconds until the key may try again, or 0 if it may try now. */
  blockedFor(key: string, now = Date.now()): number {
    const e = this.live(key, now);
    return e && e.failures + e.pending >= this.max ? Math.ceil((e.resetAt - now) / 1000) : 0;
  }

  /** Reserves an attempt for `key`. Call right after `blockedFor` answered 0, with no `await` in between. */
  begin(key: string, now = Date.now()): void {
    this.prune(now);
    const e = this.live(key, now);
    if (e) e.pending++;
    else this.entries.set(key, { failures: 0, pending: 1, resetAt: now + this.windowMs });
  }

  /** Settles an attempt reserved with `begin`: a failure stays counted, a success is given back. */
  end(key: string, failed: boolean, now = Date.now()): void {
    const e = this.live(key, now);
    if (!e || e.pending === 0) throw new Error(`AttemptLimiter.end without begin for ${key}`);
    e.pending--;
    if (failed) e.failures++;
    else if (e.failures === 0 && e.pending === 0) this.entries.delete(key);
  }

  // The key's entry with an ended window rolled over: dropped if nothing is in flight, else restarted without failures.
  private live(key: string, now: number) {
    const e = this.entries.get(key);
    if (!e || e.resetAt > now) return e;
    if (e.pending === 0) { this.entries.delete(key); return undefined; }
    e.failures = 0; e.resetAt = now + this.windowMs;
    return e;
  }

  // Drops ended windows, so the map holds only keys that were tried within the last window or are in flight.
  private prune(now: number): void {
    if (this.entries.size < 1024) return;
    for (const [k, e] of this.entries) if (e.resetAt <= now && e.pending === 0) this.entries.delete(k);
  }
}
