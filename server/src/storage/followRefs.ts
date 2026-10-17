import type { Db } from '../db.ts';
import { deleteComments, keysOf, moveComments } from './comments.ts';
import { deleteFavourites, moveFavourites } from './favourites.ts';
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
  if (source !== 'home') {
    deleteFavourites(db, userId, source, paths);
    deleteTags(db, userId, source, paths);
  }
}
