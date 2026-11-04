/** One long-lived streaming input queue per native session. */
export class InputQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | undefined;
  private closed = false;
  push(value: T): void {
    if (this.closed) throw new Error('Input queue closed');
    if (this.waiter) { const resolve = this.waiter; this.waiter = undefined; resolve({ value, done: false }); }
    else this.values.push(value);
  }
  close(): void { this.closed = true; this.values = []; this.waiter?.({ value: undefined, done: true }); this.waiter = undefined; }
  [Symbol.asyncIterator](): AsyncIterator<T> { return { next: () => {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => { this.waiter = resolve; });
  } }; }
}
