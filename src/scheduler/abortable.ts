/** Stop waiting for pre-turn setup without treating it as a submitted turn. */
export function abortable<T>(operation: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (fn: () => void) => { clearTimeout(timer); signal.removeEventListener('abort', abort); fn(); };
    const abort = () => finish(() => reject(new Error('Provider setup cancelled')));
    const timer = setTimeout(() => finish(() => reject(new Error('Provider setup timed out'))), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal.aborted) abort();
  });
}
