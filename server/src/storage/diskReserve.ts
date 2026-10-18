import { statfs } from 'node:fs/promises';
import type { DiskStatus } from '@files/shared';
import type { Db } from '../db.ts';
import { AppError } from '../errors.ts';

// The disk reserve (#320): Files refuses any write that would leave less than the reserve free on its data volume, so a
// member never fills the shard's disk for every app and the platform (FreeshardBase/freeshard#261). Unlike a quota it is
// one figure for the whole shard: every member's writes, copies and open uploads take from the same free bytes.

const GiB = 1024 ** 3;
/** Without FILES_DISK_RESERVE: the larger of these. */
export const DEFAULT_RESERVE = { bytes: 5 * GiB, percent: 5 };
/** From this share of the volume used, the admin is warned. */
export const WARN_USED = 0.9;

/** The volume's size and the bytes still free on it, in bytes. */
export type DiskSpace = { total: number; free: number };
export type DiskSpaceProvider = (dir: string) => Promise<DiskSpace>;
/** The real volume of `dir`; `bavail`, the blocks an unprivileged process may still use, not `bfree`. */
export const statfsSpace: DiskSpaceProvider = async (dir) => {
  const s = await statfs(dir);
  return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
};

/** FILES_DISK_RESERVE as given (`text`) and parsed: a fixed number of bytes or a share of the volume. */
export type ReserveSetting = { text: string } & ({ bytes: number } | { percent: number });

const UNITS: Readonly<Record<string, number>> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB, TiB: 1024 ** 4,
  KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/** `10GiB`, `700MB`, `8%`; null for anything else, a zero reserve and 100 % or more. */
export function parseReserve(text: string): ReserveSetting | null {
  const m = /^(\d+(?:\.\d+)?)(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB|%)$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2] === '%') return n > 0 && n < 100 ? { text, percent: n } : null;
  const bytes = Math.floor(n * UNITS[m[2]!]!);
  return bytes >= 1 && bytes <= Number.MAX_SAFE_INTEGER ? { text, bytes } : null;
}

export function reserveBytes(setting: ReserveSetting | null, total: number): number {
  if (setting === null) return Math.max(DEFAULT_RESERVE.bytes, Math.ceil(total * DEFAULT_RESERVE.percent / 100));
  return 'bytes' in setting ? setting.bytes : Math.ceil(total * setting.percent / 100);
}

/** A write's hold on the disk: the bytes it declared; what it has `written` already shows in the free bytes. */
export type DiskHold = { bytes: number; written: number };

/**
 * The shard's free space for writes: the volume's free bytes minus the reserve minus what is promised but not yet on
 * disk, which is the rest of every open tus upload (all members) and of every write or copy in flight. Checks that take
 * their bytes run under one lock, so two writes started together never share the same free bytes. The app runs as one
 * process.
 */
export class DiskReserve {
  private holds = new Set<DiskHold>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private opts: { dir: string; db: Db; setting: ReserveSetting | null; space: DiskSpaceProvider }) {}

  async status(): Promise<DiskStatus> {
    const { total, free } = await this.opts.space(this.opts.dir);
    const reserve = reserveBytes(this.opts.setting, total);
    return { total, free, reserve, setting: this.opts.setting?.text ?? null, warning: total - free >= WARN_USED * total || free <= reserve };
  }

  /** Runs `fn` under the disk lock; whatever it checks against `left()` and then takes cannot be taken by another. */
  serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(() => undefined, () => undefined); // handled: the caller gets the error from `run`
    return run;
  }

  /**
   * Bytes that may still be written before the reserve is reached; negative once it is eaten into. `exceptUpload`'s own
   * rest is not counted (its PATCH asks whether that rest fits).
   */
  async left(exceptUpload?: string): Promise<number> {
    const { total, free } = await this.opts.space(this.opts.dir);
    let pending = this.opts.db.prepare('SELECT COALESCE(SUM(length - received), 0) FROM uploads WHERE id IS NOT ?')
      .pluck().get(exceptUpload ?? null) as number;
    for (const h of this.holds) pending += Math.max(0, h.bytes - h.written);
    return free - reserveBytes(this.opts.setting, total) - pending;
  }

  /**
   * Takes `bytes` for a write or copy, or nothing for a write of unknown length, which may then write `allowed` (what is
   * left now) and must check `left()` again while it streams. STORAGE_FULL when the bytes do not fit.
   */
  hold(bytes: number | undefined): Promise<{ hold: DiskHold; allowed: number; release: () => void }> {
    return this.serialized(async () => {
      const left = await this.left();
      if (bytes !== undefined && bytes > left) throw new AppError('STORAGE_FULL');
      const hold: DiskHold = { bytes: bytes ?? 0, written: 0 };
      this.holds.add(hold);
      return { hold, allowed: bytes ?? Math.max(0, left), release: () => { this.holds.delete(hold); } };
    });
  }
}
