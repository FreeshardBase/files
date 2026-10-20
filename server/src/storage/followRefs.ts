import type { Db } from '../db.ts';
import { deleteComments, keysOf, moveComments, type ItemKey } from './comments.ts';
import { deleteFavourites, moveFavourites } from './favourites.ts';
import { orphanPathRefs, PATH_TABLES } from './pathRefs.ts';
import { deleteTags, moveTags } from './tags.ts';

/**
 * After a move made through the app in `source` by `userId`: the rows that hang off the item follow it. In the home the
 * caller's favourites and tags followed inside the move's transaction (PATH_TABLES); in another source the provider has
 * no transaction, so they follow here once the move is done (#155, #212). Comment threads (#213) hang off the owner's
 * item: in the owner's home (also through a share) they are in PATH_TABLES, in a cloud they follow here, also when a
 * grantee moves inside a share. Used by the move route and by batch renames (#215).
 */
export function followMove(db: Db, userId: string, source: string, from: string, to: string): void {
  const keyOf = keysOf(db, userId, source);
  moveComments(db, keyOf(from), keyOf(to));
  if (source !== 'home') {
    moveFavourites(db, userId, source, from, to);
    moveTags(db, userId, source, from, to);
  }
}

/**
 * After items were deleted through the app (to the source's trash): favourites and tags go as with a move; in the home
 * the tags wait in the trash with their item, as do comment threads in the owner's home; a cloud's are deleted with the
 * item (#213). Used by the delete route and by the duplicate finder (#216).
 */
export function followDelete(db: Db, userId: string, source: string, paths: readonly string[]): void {
  const keyOf = keysOf(db, userId, source);
  deleteComments(db, paths.map(keyOf));
  orphanDeleted(db, paths.map(keyOf));
  if (source !== 'home') {
    deleteFavourites(db, userId, source, paths);
    deleteTags(db, userId, source, paths);
  }
}

/**
 * The owner's items `keys` were deleted through the app: shares, public links and file requests on a cloud item or
 * beneath it are orphaned (#418), also when a grantee deleted it inside a cloud share. The home's are orphaned by
 * `LocalBackend` in the delete's own transaction. Used by `followDelete` and by the transfer jobs that delete originals.
 */
export function orphanDeleted(db: Db, keys: readonly ItemKey[]): void {
  for (const k of keys) if (k.source !== 'home') orphanPathRefs(db, PATH_TABLES, k.owner, k.source, [k.path]);
}
