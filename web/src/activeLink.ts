import type { PublicLink } from '@files/shared';

// A public link that still opens its item (#382, #407): not expired, downloads left. An orphaned link cannot belong to
// an item that is shown.
export const isActiveLink = (l: PublicLink, now: number) => !l.orphaned
  && (l.expiresAt === null || Date.parse(l.expiresAt) > now)
  && (l.maxDownloads === null || l.downloads < l.maxDownloads);
