import { join } from 'node:path';

// The single data root (spec 3.6): every location under FILES_DATA_DIR is derived here and nowhere else.
// userId is the internal UUID from the users table, never user input.

export const dbPath = (dataDir: string): string => join(dataDir, 'files.db');

export const homesDir = (dataDir: string): string => join(dataDir, 'homes');

export const homeRoot = (dataDir: string, userId: string): string => join(homesDir(dataDir), userId);

/** The thumbnail cache (#144): beside the homes, so no user path can reach it. */
export const thumbsDir = (dataDir: string): string => join(dataDir, 'thumbs');
