/**
 * Runs `run` right away and then every `intervalMs`; a tick is skipped while the previous run is still going. A failed
 * run goes to `onError` and the next tick tries again. `stop` waits for a run in flight.
 */
export function every(intervalMs: number, run: () => Promise<unknown>, onError: (e: unknown) => void): { stop(): Promise<void> } {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return; // the previous run is still going; the next tick tries again
    running = run()
      .then(() => undefined, (e: unknown) => { onError(e); }) // handled: reported to onError; the next tick retries
      .finally(() => { running = null; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return { async stop() { clearInterval(timer); await running; } };
}
