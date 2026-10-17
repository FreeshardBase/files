import type { App } from 'vue';
import type { Router } from 'vue-router';
import { cleanReport, type ClientErrorReport } from '@files/shared';
import { csrfToken } from './api/client.ts';

// The build: the file name of the bundle this module is in (`index-<hash>.js`), which changes with every build.
const BUILD = new URL(import.meta.url).pathname.split('/').pop() ?? 'unknown';

function describe(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: `${error.name}: ${error.message}`, ...(error.stack ? { stack: error.stack } : {}) };
  return { message: String(error) };
}

/**
 * Reports browser errors to the server (#298): uncaught errors, unhandled promise rejections and Vue's render and
 * lifecycle errors. A report names the route, never the path or query, and is redacted before it leaves (the server
 * redacts again). Only a signed-in member reports: without a session's CSRF token (a public link's page, before the
 * session loaded) nothing is sent. Reporting never throws and never reports itself: a report that fails is dropped.
 * Returns the function that removes the listeners.
 */
export function installErrorReporting(app: App, router: Router): () => void {
  let reporting = false;
  const report = (error: unknown) => {
    if (reporting || !csrfToken()) return;
    reporting = true;
    try {
      const body: ClientErrorReport = cleanReport({ ...describe(error), route: String(router.currentRoute.value.name ?? 'unknown'),
        build: BUILD, userAgent: navigator.userAgent });
      fetch('/api/v1/client-errors', { method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() }, body: JSON.stringify(body) })
        .catch(() => undefined); // handled: a report that cannot be sent is dropped, never reported again
    } catch { // handled: a failure while building or sending a report drops that report; reporting it could loop
    } finally {
      reporting = false;
    }
  };
  const onError = (e: Event) => { const ev = e as ErrorEvent; report(ev.error ?? ev.message); };
  const onRejection = (e: Event) => { report((e as PromiseRejectionEvent).reason); };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  // Vue's own handler logs to the console; this one keeps that and reports.
  app.config.errorHandler = (err) => { console.error(err); report(err); };
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    app.config.errorHandler = undefined;
  };
}
