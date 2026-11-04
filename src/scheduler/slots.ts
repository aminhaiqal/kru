export class TurnSlots {
  private used = 0;
  constructor(readonly limit = 2) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Turn concurrency must be a positive integer');
  }
  get available(): boolean { return this.used < this.limit; }
  get active(): number { return this.used; }
  acquire(): (() => void) | null {
    if (!this.available) return null;
    this.used++;
    let released = false;
    return () => { if (!released) { released = true; this.used--; } };
  }
}
