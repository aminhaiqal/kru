/** Calendar days follow the configured IANA zone, including daylight-saving transitions. */
export class BudgetCalendar {
  readonly timeZone: string;
  private cachedWindow: { day: string; start: number; end: number } | undefined;
  private readonly format: Intl.DateTimeFormat;
  constructor(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    try {
      this.format = new Intl.DateTimeFormat('en-CA', {
        timeZone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit',
      });
      this.timeZone = this.format.resolvedOptions().timeZone;
    } catch { throw new Error(`Invalid budget timezone: ${timeZone}`); }
  }
  window(timestamp: number): { start: number; end: number } {
    const day = this.day(timestamp);
    if (this.cachedWindow?.day === day) return this.cachedWindow;
    const boundary = (after: boolean) => {
      let low = timestamp - 48 * 3600_000, high = timestamp + 48 * 3600_000;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2), value = this.day(middle);
        if (after ? value > day : value >= day) high = middle; else low = middle;
      }
      return high;
    };
    this.cachedWindow = { day, start: boundary(false), end: boundary(true) };
    return this.cachedWindow;
  }
  day(timestamp: number): string {
    const parts = this.format.formatToParts(new Date(timestamp));
    const part = (name: string) => parts.find(p => p.type === name)!.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
}
