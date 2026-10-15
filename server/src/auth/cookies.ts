import type { Config } from '../config.ts';

// __Host- prefix (Secure, Path=/, no Domain) blocks cookie tossing from sibling shard apps.
// Plain names only for http loopback dev/E2E, where browsers reject Secure cookies.
// `link` is a public link's unlock cookie (#147). It is scoped to `/s/<token>/`, which `__Host-` forbids (Path=/ only),
// so it carries `__Secure-`; its value is signed and names the link, so a tossed cookie unlocks nothing.
export function cookieNames(config: Config): { sid: string; login: string; link: string; prefixed: boolean } {
  const prefixed = config.publicUrl.protocol === 'https:';
  return prefixed
    ? { sid: '__Host-fs_sid', login: '__Host-fs_login', link: '__Secure-fs_link', prefixed }
    : { sid: 'fs_sid', login: 'fs_login', link: 'fs_link', prefixed };
}
