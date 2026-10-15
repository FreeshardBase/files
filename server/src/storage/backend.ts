import type { Readable } from 'node:stream';
import type { CollisionPolicy, Entry, ThumbSize } from '@files/shared';
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
    Promise<{ entry: Entry; stream: Readable; etag: string; range?: ByteRange;
      /** The length is not known before the bytes are sent (a Google-native document's export): no ranges, no Content-Length. */
      unsized?: boolean;
      /**
       * The provider's own hash of the whole file, when it lists one (Google Drive's MD5). A transfer hashes the bytes it
       * receives with the same algorithm and compares (#153). Absent for a range.
       */
      hash?: { algorithm: 'md5'; value: string } }>;
  write(path: string, body: Readable, opts: WriteOptions): Promise<Entry>;
  mkdir(path: string): Promise<Entry>;
  /** Rename or move within this source. A folder never moves into itself; "replace" sends the old target to the trash. */
  move(from: string, to: string, onCollision: CollisionPolicy): Promise<Entry>;
  /** Copy a file or a whole folder (streamed, never buffered) within this source. */
  copy(from: string, to: string, onCollision: CollisionPolicy): Promise<Entry>;
  /** Move every path to the trash, all or nothing. */
  delete(paths: readonly string[]): Promise<void>;
  /**
   * A WebP whose longer side is `size` pixels, or null if the file's type has no thumbnail. Local files are generated
   * and cached (storage/thumbnails.ts); cloud backends proxy the provider's thumbnail (#149–#151).
   */
  thumbnail?(path: string, size: ThumbSize): Promise<Readable | null>;
  /**
   * Items whose name contains `query` (literally, ignoring case), at most `limit`. The home answers from its name index;
   * cloud backends ask their provider live (#149–#151). A failure is reported for this source only (routes/search.ts).
   */
  search?(query: string, limit: number): Promise<Entry[]>;
  /** The provider's storage use and limit (cloud backends; the storage overview shows it). */
  quota?(): Promise<{ used: number; total?: number }>;
  /** The provider's stored revisions of a file, oldest first (cloud backends; restoring comes with versions). */
  revisions?(path: string): Promise<Revision[]>;
  /**
   * SHA-256 (hex) of a file's bytes as stored. A transfer (#152) compares it with the hash of the bytes it sent. Only the
   * home offers it today: the providers' own hashes use other algorithms (DECISIONS, #152).
   */
  digest?(path: string): Promise<string>;
}

export type Revision = { id: string; modified: string; size?: number };

/** One of the member's own cloud connections, searched and addressed as the source `conn:<id>`. */
export type ConnectedBackend = { id: string; backend: StorageBackend };
