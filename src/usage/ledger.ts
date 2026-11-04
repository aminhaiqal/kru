import type { Batch } from '../mailbox';
import type { TokenUsage } from '../providers/protocol';
import { BudgetCalendar } from '../scheduler/budget-day';
import { estimateCost, modelPrices, type CostEstimate } from './pricing';

export interface UsageRecord {
  laneId?: string | null; priceId?: string | null; recordedAt?: string;
  batchId: string; agentId: string; provider: string; model: string; threadId: string | null; turnId: string | null;
  cause: string; deliveryIds: string[]; chainIds: string[]; phase: 'prepared' | 'submitted' | 'final';
  outcome: string | null; usage: TokenUsage | null; cost: CostEstimate | null; complete: boolean;
  resolution: { tokens: number; nanoUsd: number; note: string; at: string } | null;
  startedAt: string; updatedAt: string;
}
export interface UsageTotals { tokens: number; nanoUsd: number; unknownTokens: boolean; unknownUsd: boolean }
export interface UsageLedger {
  flush?():void;
  onChange(listener: () => void): () => void;
  begin(batch: Batch, provider: string, model: string, startedAt?: string): void;
  submitted(id: string): void;
  started(id: string, threadId: string, turnId: string, start?: () => void): void;
  observe(id: string, usage: TokenUsage): void;
  abandon(id: string, restore: () => void): void;
  settle(id: string, outcome: string, confirmed: boolean, finish: () => void): void;
  recover(): void;
  list(agentId?: string): UsageRecord[];
  totals(agentId: string, calendar: BudgetCalendar, now: number): UsageTotals;
  isPriced(provider: string, model: string, at: string): boolean;
}
export function totals(records: UsageRecord[], agentId: string, calendar: BudgetCalendar, now: number): UsageTotals {
  const today = calendar.day(now);
  const total: UsageTotals = { tokens: 0, nanoUsd: 0, unknownTokens: false, unknownUsd: false };
  for (const r of records) {
    const uncertain = !r.complete || r.usage === null || r.cost?.maximumNanoUsd == null;
    if (r.agentId !== agentId || (calendar.day(Date.parse(r.recordedAt ?? r.startedAt)) !== today && r.phase === 'final' && (!uncertain || r.resolution))) continue;
    if (r.resolution) { total.tokens += r.resolution.tokens; total.nanoUsd += r.resolution.nanoUsd; continue; }
    total.tokens += r.usage?.last.totalTokens ?? 0;
    total.nanoUsd += r.cost?.maximumNanoUsd ?? 0;
    total.unknownTokens ||= !r.complete || r.usage === null;
    total.unknownUsd ||= !r.complete || r.cost?.maximumNanoUsd == null;
  }
  return total;
}
/** Standalone scheduler fixture; the daemon uses SQLite so limits survive restarts. */
export class MemoryUsageLedger implements UsageLedger {
  isPriced(_provider: string, model: string, _at: string): boolean { return Boolean(modelPrices[model]); }
  protected records = new Map<string, UsageRecord>();
  private readonly listeners = new Set<() => void>();
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  protected changed(): void { for (const listener of this.listeners) listener(); }
  begin(batch: Batch, provider: string, model: string, startedAt?: string): void {
    if (this.records.has(batch.id)) throw new Error('Usage batch already exists');
    const now = startedAt ?? new Date().toISOString();
    this.records.set(batch.id, { batchId: batch.id, agentId: batch.agentId, provider, model, threadId: null, turnId: null,
      laneId: batch.laneId, priceId: null, recordedAt: now,
      cause: batch.deliveries[0]!.sender.kind, deliveryIds: batch.deliveries.map(d => d.id), chainIds: [...new Set(batch.deliveries.map(d => d.chainId))],
      phase: 'prepared', outcome: null, usage: null, cost: null, complete: false, resolution: null, startedAt: now, updatedAt: now });
    this.changed();
  }
  protected get(id: string): UsageRecord {
    const row = this.records.get(id); if (!row) throw new Error(`Unknown usage batch: ${id}`); return row;
  }
  submitted(id: string): void { const row = this.get(id); if (row.phase !== 'prepared') throw new Error('Usage already submitted'); row.phase = 'submitted'; this.changed(); }
  started(id: string, threadId: string, turnId: string, start?: () => void): void { Object.assign(this.get(id), { threadId, turnId }); start?.(); this.changed(); }
  observe(id: string, usage: TokenUsage): void {
    const row = this.get(id); if (row.phase === 'final') throw new Error('Final usage cannot be changed'); row.model = usage.model ?? row.model; row.usage = structuredClone(usage); row.cost = estimateCost(row.model, usage.last); this.changed();
  }
  abandon(id: string, restore: () => void): void { restore(); this.records.delete(id); this.changed(); }
  settle(id: string, outcome: string, confirmed: boolean, finish: () => void): void {
    const row = this.get(id); if (row.phase === 'final') throw new Error('Usage already final'); finish(); row.phase = 'final'; row.outcome = outcome; row.complete = confirmed && row.usage !== null; this.changed();
  }
  recover(): void {
    for (const [id, row] of this.records) {
      if (row.phase === 'prepared') this.records.delete(id);
      else if (row.phase !== 'final') { row.phase = 'final'; row.outcome = 'interrupted'; row.complete = false; }
    }
    this.changed();
  }
  list(agentId?: string): UsageRecord[] { return [...this.records.values()].filter(r => agentId === undefined || r.agentId === agentId).map(r => structuredClone(r)); }
  totals(agentId: string, calendar: BudgetCalendar, now: number): UsageTotals { return totals(this.list(agentId), agentId, calendar, now); }
}
