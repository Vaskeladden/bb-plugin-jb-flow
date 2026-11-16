// How a background service ends. bb aborts the service's signal on a reload
// and gives it five seconds to return; one that does not leaves the plugin
// degraded, and one that never does keeps it degraded until bb restarts.
// Every wait in a service therefore goes through these three, which all end
// at the stop and all cope with a signal that has already aborted (a listener
// added to an aborted signal never fires).

/** Resolves when bb stops the service; at once when it already has. */
export function stopOf(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * `work`, or the stop, whichever comes first. Work left behind at a stop
 * carries on by itself and should look at the signal between steps; its
 * result and its error are dropped. An error before the stop is thrown.
 */
export function orStop(signal: AbortSignal, work: Promise<unknown>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stop = () => resolve();
    work.then(
      () => {
        signal.removeEventListener("abort", stop);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

/** Waits `ms`, or until the stop. */
export function pause(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
