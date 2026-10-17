import type { Config } from '../config.ts';

// __Host- prefix (Secure, Path=/, no Domain) blocks cookie tossing from sibling shard apps.
// Plain names only for http loopback dev/E2E, where browsers reject Secure cookies.
// `link` is a public link's unlock cookie (#147). It is scoped to `/s/<token>/`, which `__Host-` forbids (Path=/ only),
// so it carries `__Secure-`; its value is signed and names the link, so a tossed cookie unlocks nothing.
// `request` is a file request's visitor cookie (#217), scoped to `/r/<token>/` the same way: the visitor's random id and,
// once the password is entered, the unlock.
export function cookieNames(config: Config): { sid: string; login: string; link: string; request: string; prefixed: boolean } {
  const prefixed = config.publicUrl.protocol === 'https:';
  return prefixed
    ? { sid: '__Host-fs_sid', login: '__Host-fs_login', link: '__Secure-fs_link', request: '__Secure-fs_req', prefixed }
    : { sid: 'fs_sid', login: 'fs_login', link: 'fs_link', request: 'fs_req', prefixed };
}
