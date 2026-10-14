import type { Config } from '../config.ts';

// __Host- prefix (Secure, Path=/, no Domain) blocks cookie tossing from sibling shard apps.
// Plain names only for http loopback dev/E2E, where browsers reject Secure cookies.
export function cookieNames(config: Config): { sid: string; login: string; prefixed: boolean } {
  const prefixed = config.publicUrl.protocol === 'https:';
  return prefixed
    ? { sid: '__Host-fs_sid', login: '__Host-fs_login', prefixed }
    : { sid: 'fs_sid', login: 'fs_login', prefixed };
}
