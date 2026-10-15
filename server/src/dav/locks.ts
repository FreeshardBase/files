import { randomUUID } from 'node:crypto';
import { isUnder, parentOf } from './paths.ts';

// WebDAV write locks (class 2, RFC 4918 §6–7), per member: a member's home is reachable only by that member, so another
// member's lock never applies. They live in memory: the app is one process, and a lock lost on restart only means a
// client takes it again (a lock is advisory between the member's own clients; nothing else honours it).

export type Lock = { token: string; userId: string; root: string; depth: '0' | 'infinity'; scope: 'exclusive' | 'shared';
  ownerXml: string; timeoutSeconds: number; expires: number };

export const MAX_TIMEOUT_SECONDS = 24 * 3600;
const DEFAULT_TIMEOUT_SECONDS = 3600;

/** `Timeout: Second-600, Infinite`: the first value we understand, capped at a day. */
export function parseTimeout(header: string | undefined): number {
  for (const part of (header ?? '').split(',').map((s) => s.trim())) {
    if (/^Infinite$/i.test(part)) return MAX_TIMEOUT_SECONDS;
    const m = /^Second-(\d{1,10})$/i.exec(part);
    if (m) return Math.min(Math.max(Number(m[1]), 1), MAX_TIMEOUT_SECONDS);
  }
  return DEFAULT_TIMEOUT_SECONDS;
}

export class LockStore {
  private locks = new Map<string, Lock>();

  private live(userId: string): Lock[] {
    const now = Date.now();
    const out: Lock[] = [];
    for (const l of this.locks.values()) {
      if (l.expires <= now) { this.locks.delete(l.token); continue; }
      if (l.userId === userId) out.push(l);
    }
    return out;
  }

  /**
   * The locks that protect `path`: on it, or depth infinity on a folder above. `membership` (the item is created,
   * removed or moved): the locks of its parent folder too, at any depth, since they lock the folder's member list.
   */
  protecting(userId: string, path: string, membership: boolean): Lock[] {
    return this.live(userId).filter((l) => l.root === path || (l.depth === 'infinity' && isUnder(path, l.root))
      || (membership && path !== '/' && l.root === parentOf(path)));
  }

  /** Locks on items strictly beneath `path` (they go with a folder that is deleted or moved). */
  beneath(userId: string, path: string): Lock[] {
    return this.live(userId).filter((l) => l.root !== path && isUnder(l.root, path));
  }

  /** A new lock conflicts with an exclusive lock anywhere it reaches, and an exclusive one with any lock there. */
  conflicts(userId: string, path: string, depth: '0' | 'infinity', scope: 'exclusive' | 'shared'): boolean {
    const reached = [...this.protecting(userId, path, false), ...(depth === 'infinity' ? this.beneath(userId, path) : [])];
    return reached.some((l) => scope === 'exclusive' || l.scope === 'exclusive');
  }

  create(l: Omit<Lock, 'token' | 'expires'>): Lock {
    const lock: Lock = { ...l, token: `opaquelocktoken:${randomUUID()}`, expires: Date.now() + l.timeoutSeconds * 1000 };
    this.locks.set(lock.token, lock);
    return lock;
  }

  get(userId: string, token: string): Lock | undefined {
    return this.live(userId).find((l) => l.token === token);
  }

  refresh(lock: Lock, timeoutSeconds: number): Lock {
    lock.timeoutSeconds = timeoutSeconds;
    lock.expires = Date.now() + timeoutSeconds * 1000;
    return lock;
  }

  remove(token: string): void { this.locks.delete(token); }

  /** The item at `path` is gone (deleted, or moved away): its locks and those beneath it end. */
  removeUnder(userId: string, path: string): void {
    for (const l of this.live(userId)) if (isUnder(l.root, path)) this.locks.delete(l.token);
  }
}
