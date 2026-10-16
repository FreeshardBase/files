// Files service worker (#158): the app shell for a start without network, and the Web Share Target. No file data is
// cached: the API is never answered from here, so offline the app shows its offline state instead of stale listings.
// Plain JavaScript, copied as is into the build (web/public), so the browser can fetch it at the root scope.

const SHELL = 'files-shell-v1';
const SHARE_TARGET = '/api/v1/share-target';
// The share inbox: shared files wait here, in the browser, until the member picks a folder. Same names in
// web/src/shareInbox.ts, which reads and removes them.
const INBOX_DB = 'files-share-inbox';
const INBOX_STORE = 'shares';
const INBOX_MAX_AGE_MS = 24 * 3600 * 1000;

// Paths the shell answers when there is no network: everything the SPA routes. The server's own paths never are.
const isAppPage = (path) => !/^\/(api|auth|dav)(\/|$)/.test(path);
// The same-origin files a shell page references (the hashed bundle, manifest, icons).
const shellRefs = (html) => [...new Set([...html.matchAll(/(?:src|href)="(\/[^/"][^"]*)"/g)].map((m) => m[1]))];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const res = await fetch('/index.html', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`app shell: ${res.status}`);
    await storeShell(res);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method === 'POST' && url.pathname === SHARE_TARGET) event.respondWith(receiveShare(req));
  else if (req.method !== 'GET') return;
  else if (req.mode === 'navigate' && isAppPage(url.pathname)) event.respondWith(appPage(req));
  else if (url.pathname.startsWith('/assets/')) event.respondWith(asset(req));
});

/** Keeps this index.html and what it references; assets of an older build are dropped, so the cache stays one build. */
async function storeShell(res) {
  const cache = await caches.open(SHELL);
  const html = await res.clone().text();
  const refs = shellRefs(html);
  await cache.addAll(refs.filter((r) => !r.startsWith('/assets/')));
  for (const r of refs.filter((p) => p.startsWith('/assets/'))) {
    if (!(await cache.match(r))) await cache.add(r);
  }
  await cache.put('/index.html', res);
  // Lazily loaded chunks (the PDF viewer) are dropped too; they are cached again on their next use.
  for (const key of await cache.keys()) {
    const path = new URL(key.url).pathname;
    if (path.startsWith('/assets/') && !refs.includes(path)) await cache.delete(key);
  }
}

/** Network first, so a new build is picked up at once; without network the cached shell. */
async function appPage(req) {
  let res;
  try { res = await fetch(req); }
  catch (e) { // handled: no network, the cached shell answers; without one the navigation fails as it would have
    const shell = await caches.match('/index.html');
    if (shell) return shell;
    throw e;
  }
  const html = res.ok && !res.redirected && (res.headers.get('content-type') ?? '').startsWith('text/html');
  const cached = await caches.match('/index.html');
  if (html && (!cached || (await cached.text()) !== (await res.clone().text()))) await storeShell(res.clone());
  return res;
}

/** Hashed bundle files never change: from the cache, else from the network into the cache. */
async function asset(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await (await caches.open(SHELL)).put(req, res.clone());
  return res;
}

/** The share sheet's POST: the files go into the inbox, then the member picks a folder on the share page. */
async function receiveShare(req) {
  // #281: a share sheet sends no referrer; a form on another website does unless it suppresses it. Such a POST is
  // refused unread, so another site cannot put files on the share page (one that hides its referrer still can).
  if (req.referrer && new URL(req.referrer).origin !== self.location.origin) return Response.redirect('/share-target?refused', 303);
  const form = await req.formData();
  const files = form.getAll('files').filter((f) => f instanceof File);
  const id = crypto.randomUUID();
  await inbox((store) => {
    // Shares never saved are dropped after a day, so the browser keeps no forgotten copies.
    store.openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      if (cursor.value.created < Date.now() - INBOX_MAX_AGE_MS) cursor.delete();
      cursor.continue();
    };
    store.put({ id, created: Date.now(), files });
  });
  return Response.redirect(`/share-target/${id}`, 303);
}

function inbox(work) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(INBOX_DB, 1);
    open.onupgradeneeded = () => { open.result.createObjectStore(INBOX_STORE, { keyPath: 'id' }); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(INBOX_STORE, 'readwrite');
      work(tx.objectStore(INBOX_STORE));
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
