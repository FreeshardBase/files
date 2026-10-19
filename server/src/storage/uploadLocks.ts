import { AppError } from '../errors.ts';

// One request at a time per upload (tus forbids concurrent PATCHes); the app runs as one process.
const busyUploads = new Set<string>();

/** True while a request of upload `id` runs; an expired upload still holds what it is receiving (#364). */
export const uploadBusy = (id: string): boolean => busyUploads.has(id);

export async function withUpload<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (busyUploads.has(id)) throw new AppError('UPLOAD_LOCKED');
  busyUploads.add(id);
  try { return await fn(); } finally { busyUploads.delete(id); }
}
