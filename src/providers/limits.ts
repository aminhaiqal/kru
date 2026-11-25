import type { ConnectedProvider } from './connections';

export interface LimitWindow {
  id: string;
  label: string;
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
}
export interface ProviderLimits {
  provider: ConnectedProvider;
  status: 'available' | 'unavailable';
  checkedAt: string;
  windows: LimitWindow[];
}
function window(
  id: string,
  label: string,
  used: unknown,
  minutes: unknown,
  reset: unknown,
): LimitWindow[] {
  if (typeof used !== 'number' || !Number.isFinite(used)) return [];
  const time =
    typeof reset === 'number' ? reset * 1000 : typeof reset === 'string' ? Date.parse(reset) : NaN;
  return [
    {
      id,
      label,
      usedPercent: Math.min(100, Math.max(0, used)),
      windowMinutes: typeof minutes === 'number' && minutes > 0 ? minutes : null,
      resetsAt: Number.isFinite(time) ? new Date(time).toISOString() : null,
    },
  ];
}
function duration(minutes: unknown): string {
  if (minutes === 10080) return 'Weekly';
  if (typeof minutes !== 'number' || minutes <= 0) return 'Usage';
  return minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
}
export function codexLimits(data: any): LimitWindow[] {
  const buckets = data?.rateLimitsByLimitId;
  const rows = buckets && Object.keys(buckets).length ? Object.values(buckets) : [data?.rateLimits];
  return rows.flatMap((row: any) => {
    if (!row) return [];
    return ['primary', 'secondary'].flatMap((key) => {
      const value = row[key];
      if (!value) return [];
      const label = duration(value.windowDurationMins);
      return window(
        `${row.limitId || 'codex'}:${key}`,
        row.limitName ? `${row.limitName} · ${label}` : label,
        value.usedPercent,
        value.windowDurationMins,
        value.resetsAt,
      );
    });
  });
}
export function claudeLimits(data: any): LimitWindow[] {
  if (data?.rate_limits_available !== true || !data.rate_limits) return [];
  const windows = Object.entries(data.rate_limits).flatMap(([id, value]: [string, any]) => {
    if (!id.startsWith('five_hour') && !id.startsWith('seven_day')) return [];
    const weekly = id.startsWith('seven_day');
    const suffix = id.replace(/^(five_hour|seven_day)_?/, '').replaceAll('_', ' ');
    return window(
      id,
      (weekly ? 'Weekly' : '5-hour') + (suffix ? ' · ' + suffix : ''),
      value?.utilization,
      weekly ? 10080 : 300,
      value?.resets_at,
    );
  });
  for (const item of data.rate_limits.model_scoped || [])
    windows.push(
      ...window(
        'model:' + item.display_name,
        'Weekly · ' + item.display_name,
        item.utilization,
        10080,
        item.resets_at,
      ),
    );
  const extra = data.rate_limits.extra_usage;
  if (extra?.is_enabled)
    windows.push(...window('extra_usage', 'Extra usage', extra.utilization, null, null));
  return windows;
}

/** Account metadata only. Coalesced and cached; never generates a model turn. */
export class UsageLimits {
  private cached = new Map<ConnectedProvider, { at: number; value: ProviderLimits }>();
  private pending = new Map<ConnectedProvider, Promise<ProviderLimits>>();
  private revision = new Map<ConnectedProvider, number>();
  constructor(private readonly load: (provider: ConnectedProvider) => Promise<LimitWindow[]>) {}
  invalidate(id: ConnectedProvider) {
    this.cached.delete(id);
    this.revision.set(id, (this.revision.get(id) || 0) + 1);
  }
  async read(id: ConnectedProvider): Promise<ProviderLimits> {
    const old = this.cached.get(id);
    if (old && Date.now() - old.at < 120000) return structuredClone(old.value);
    let task = this.pending.get(id);
    if (!task) {
      const revision = this.revision.get(id);
      task = this.load(id)
        .catch(() => [])
        .then((windows) => {
          const value: ProviderLimits = {
            provider: id,
            status: windows.length ? 'available' : 'unavailable',
            checkedAt: new Date().toISOString(),
            windows,
          };
          if (this.revision.get(id) !== revision)
            return { ...value, status: 'unavailable' as const, windows: [] };
          this.cached.set(id, { at: Date.now(), value });
          return value;
        })
        .finally(() => this.pending.delete(id));
      this.pending.set(id, task);
    }
    return structuredClone(await task);
  }
}
