import type { Readable } from 'node:stream';
import type { CollisionPolicy, Entry } from '@files/shared';

export interface StorageBackend {
  list(path: string, cursor?: string, limit?: number): Promise<{ entries: Entry[]; next?: string }>;
  stat(path: string): Promise<Entry>;
  read(path: string, range?: { start: number; end: number }): Promise<{ stream: Readable; size: number; etag: string; mime: string }>;
  write(path: string, body: Readable, opts: { onCollision: CollisionPolicy; maxBytes: number }): Promise<Entry>;
  mkdir(path: string): Promise<Entry>;
}
