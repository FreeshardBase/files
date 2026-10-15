import type { Readable } from 'node:stream';
import type { CollisionPolicy, Entry } from '@files/shared';
import { AppError } from '../errors.ts';

export type ByteRange = { start: number; end: number };

/** Carries the size the backend saw, so the route can answer `Content-Range: bytes *\/<size>`. */
export class RangeNotSatisfiable extends AppError {
  constructor(readonly size: number) { super('RANGE_NOT_SATISFIABLE'); }
}

export type WriteOptions = {
  onCollision: CollisionPolicy;
  maxBytes: number;
  /** Declared length; a body with more or fewer bytes fails with SIZE_MISMATCH and leaves nothing behind. */
  size?: number;
  /** Replace only if the current file has this ETag (needs onCollision `replace`), else PRECONDITION_FAILED. */
  ifMatch?: string;
};

export interface StorageBackend {
  list(path: string, cursor?: string, limit?: number): Promise<{ entries: Entry[]; next?: string }>;
  stat(path: string): Promise<Entry>;
  /**
   * One round trip: the entry comes with the stream. A function range is resolved against the size of the
   * opened file (it may throw RangeNotSatisfiable); `range` in the result is the one actually served.
   */
  read(path: string, range?: ByteRange | ((size: number) => ByteRange | undefined)):
    Promise<{ entry: Entry; stream: Readable; etag: string; range?: ByteRange }>;
  write(path: string, body: Readable, opts: WriteOptions): Promise<Entry>;
  mkdir(path: string): Promise<Entry>;
}
