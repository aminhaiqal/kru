import type { Store } from '../store';
import type { Batch } from '../mailbox';
import type { TokenUsage } from '../providers/protocol';
import { BudgetCalendar } from '../scheduler/budget-day';
import { MemoryUsageLedger, totals, type UsageRecord } from './ledger';

/** One durable record per claimed batch/native turn. Stored estimates retain their price snapshot. */
export class SqliteUsageLedger extends MemoryUsageLedger {
  constructor(private readonly store: Store) { super(); }
  override onChange(listener: () => void): () => void {
    return this.store.onChange(change => { if (change.topic === 'usage') listener(); });
  }
  private read(id: string): UsageRecord {
    const row = this.store.db.query('SELECT * FROM usage_records WHERE batch_id = ?').get(id);
    if (!row) throw new Error(`Unknown usage batch: ${id}`); return this.decode([row])[0]!;
  }
  private save(row: UsageRecord): void {
    this.store.write(() => this.store.db.query(`INSERT INTO usage_records
      (batch_id, agent_id, provider, model, thread_id, turn_id, cause, deliveries_json, chains_json, phase, outcome, usage_json, cost_json, complete, resolution_json, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET model = excluded.model, thread_id = excluded.thread_id, turn_id = excluded.turn_id,
      phase = excluded.phase, outcome = excluded.outcome, usage_json = excluded.usage_json, cost_json = excluded.cost_json,
      complete = excluded.complete, resolution_json = excluded.resolution_json, updated_at = excluded.updated_at`).run(
      row.batchId, row.agentId, row.provider, row.model, row.threadId, row.turnId, row.cause,
      JSON.stringify(row.deliveryIds), JSON.stringify(row.chainIds), row.phase, row.outcome,
      row.usage ? JSON.stringify(row.usage) : null, row.cost ? JSON.stringify(row.cost) : null, Number(row.complete),
      row.resolution ? JSON.stringify(row.resolution) : null, row.startedAt, new Date().toISOString()));
    this.store.publishChanges([{ topic: 'usage', id: row.batchId }]);
  }
  private mutate(id: string, change: () => void): void {
    this.store.atomic(() => {
      this.records.set(id, this.read(id));
      try { change(); this.save(this.get(id)); } finally { this.records.delete(id); }
    });
  }
  override begin(batch: Batch, provider: string, model: string, startedAt?: string): void {
    this.store.atomic(() => {
      if (this.store.db.query('SELECT 1 FROM usage_records WHERE batch_id = ?').get(batch.id)) throw new Error('Usage batch already exists');
      super.begin(batch, provider, model, startedAt);
      try { this.save(this.get(batch.id)); } finally { this.records.delete(batch.id); }
    });
  }
  override submitted(id: string): void { this.mutate(id, () => super.submitted(id)); }
  override started(id: string, threadId: string, turnId: string): void { this.mutate(id, () => super.started(id, threadId, turnId)); }
  override observe(id: string, usage: TokenUsage): void { this.mutate(id, () => super.observe(id, usage)); }
  override abandon(id: string, restore: () => void): void {
    this.store.atomic(() => { this.store.write(() => this.store.db.query('DELETE FROM usage_records WHERE batch_id = ?').run(id)); restore();
      this.store.publishChanges([{ topic: 'usage', id }]); });
  }
  override settle(id: string, outcome: string, confirmed: boolean, finish: () => void): void {
    this.mutate(id, () => super.settle(id, outcome, confirmed, finish));
  }
  override recover(): void {
    this.store.write(() => {
      this.store.db.exec("DELETE FROM usage_records WHERE phase = 'prepared'");
      this.store.db.query("UPDATE usage_records SET phase = 'final', outcome = 'interrupted', complete = 0, updated_at = ? WHERE phase = 'submitted'").run(new Date().toISOString());
    });
  }
  acknowledge(id: string, tokens: number, nanoUsd: number, note: string): void {
    if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(nanoUsd) || nanoUsd < 0 || !note.trim()) throw new Error('Provide nonnegative usage bounds and a note');
    this.mutate(id, () => {
      const row = this.get(id);
      if (row.phase !== 'final' || row.resolution) throw new Error('Only an unresolved final record can be acknowledged once');
      if (tokens < (row.usage?.last.totalTokens ?? 0) || nanoUsd < (row.cost?.maximumNanoUsd ?? 0)) throw new Error('Bounds cannot reduce observed usage');
      row.resolution = { tokens, nanoUsd, note, at: new Date().toISOString() };
    });
  }
  override list(agentId?: string): UsageRecord[] {
    const rows = agentId === undefined ? this.store.db.query('SELECT * FROM usage_records ORDER BY started_at, batch_id').all()
      : this.store.db.query('SELECT * FROM usage_records WHERE agent_id = ? ORDER BY started_at, batch_id').all(agentId);
    return this.decode(rows);
  }
  private decode(rows: unknown[]): UsageRecord[] {
    return (rows as Record<string, unknown>[]).map(r => ({
      batchId: String(r.batch_id), agentId: String(r.agent_id), provider: String(r.provider), model: String(r.model),
      threadId: r.thread_id as string | null, turnId: r.turn_id as string | null, cause: String(r.cause),
      deliveryIds: JSON.parse(String(r.deliveries_json)), chainIds: JSON.parse(String(r.chains_json)),
      phase: r.phase as UsageRecord['phase'], outcome: r.outcome as string | null,
      usage: r.usage_json === null ? null : JSON.parse(String(r.usage_json)), cost: r.cost_json === null ? null : JSON.parse(String(r.cost_json)),
      complete: Boolean(r.complete), resolution: r.resolution_json === null ? null : JSON.parse(String(r.resolution_json)),
      startedAt: String(r.started_at), updatedAt: String(r.updated_at),
    }));
  }
  override totals(agentId: string, calendar: BudgetCalendar, now: number) {
    const window = calendar.window(now);
    const rows = this.store.db.query(`SELECT * FROM usage_records WHERE agent_id = ?
      AND ((started_at >= ? AND started_at < ?) OR phase <> 'final')`).all(agentId, new Date(window.start).toISOString(), new Date(window.end).toISOString());
    return totals(this.decode(rows), agentId, calendar, now);
  }
}
