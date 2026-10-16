// The share inbox (#158): files shared to Files from the phone wait in the browser's IndexedDB until the member picks a
// folder. The service worker (web/public/sw.js) writes them under the same names; nothing of them reaches the server
// before the upload.

const DB = 'files-share-inbox';
const STORE = 'shares';

export type Share = { id: string; created: number; files: File[] };

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => { open.result.createObjectStore(STORE, { keyPath: 'id' }); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const req = work(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => { db.close(); resolve(req.result); };
      req.onerror = () => { db.close(); reject(req.error); };
    };
  });
}

/** The share the service worker received under this id, or undefined once it was saved, discarded or expired. */
export const getShare = (id: string): Promise<Share | undefined> => run<Share | undefined>('readonly', (s) => s.get(id));
export const deleteShare = async (id: string): Promise<void> => { await run('readwrite', (s) => s.delete(id)); };
/** Drops every waiting share: after sign-out (#222) the next person on the device must not find them. */
export const clearShares = async (): Promise<void> => { await run('readwrite', (s) => s.clear()); };
