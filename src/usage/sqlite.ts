import type { Store } from '../store';
import type { Batch } from '../mailbox';
import type { TokenUsage } from '../providers/protocol';
import { BudgetCalendar } from '../scheduler/budget-day';
import { MemoryUsageLedger, totals, type UsageRecord } from './ledger';
import { PriceBook, priceRow } from '../cost/prices';
import { estimateCost } from './pricing';
import type { UsageRow } from '../store/event-types';
import type { RecoveryUsageRow } from '../boot/types';

/** One durable record per claimed batch/native turn. Stored estimates retain their price snapshot. */
export class SqliteUsageLedger extends MemoryUsageLedger {
  private pending=new Map<string,TokenUsage>();
  private checkpointAt=new Map<string,number>();
  constructor(private readonly store: Store) { super(); }
  override onChange(listener: () => void): () => void {
    return this.store.onChange(change => { if (change.topic === 'usage' || change.topic === 'prices') listener(); });
  }
  override isPriced(provider: string, model: string, at: string): boolean {
    const book = new PriceBook(this.store);
    return Boolean(book.find(provider, model, at) ?? (provider === 'fake' ? book.find('claude', model, at) : null));
  }
  private read(id: string): UsageRecord {
    const row = this.store.db.query('SELECT * FROM usage_records WHERE batch_id = ?').get(id);
    if (!row) throw new Error(`Unknown usage batch: ${id}`); return this.decode([row])[0]!;
  }
  private save(row: UsageRecord): void {
    if (!row.priceId && row.cost?.price) {
      const price = priceRow(row.provider, row.cost.price);
      this.store.emit('price.configured', { row: price }); row.priceId = price.id;
    }
    const count = row.usage?.last;
    const value: UsageRow = { batch_id: row.batchId, agent_id: row.agentId, provider: row.provider, model: row.model,
      thread_id: row.threadId, turn_id: row.turnId, cause: row.cause, deliveries_json: JSON.stringify(row.deliveryIds),
      chains_json: JSON.stringify(row.chainIds), phase: row.phase, outcome: row.outcome,
      usage_json: row.usage ? JSON.stringify(row.usage) : null, cost_json: row.cost ? JSON.stringify(row.cost) : null,
      complete: Number(row.complete), resolution_json: row.resolution ? JSON.stringify(row.resolution) : null,
      started_at: row.startedAt, updated_at: new Date().toISOString(), lane_key: row.laneId ?? '', price_id: row.priceId ?? null,
      recorded_at: row.recordedAt ?? row.startedAt, input_total: count?.inputTotal ?? null, cached_read: count?.cachedRead ?? null,
      cache_write: count?.cacheWrite ?? null, cache_write_5m: count?.cacheWriteByLifetime?.fiveMinutes ?? null,
      cache_write_1h: count?.cacheWriteByLifetime?.oneHour ?? null, output: count?.output ?? null,
      cost_usd: row.cost?.maximumNanoUsd == null ? null : row.cost.maximumNanoUsd / 1e9, estimated: 1 };
    this.store.emit(row.resolution ? 'usage.resolved' : row.phase === 'final' ? 'usage.recorded' : row.phase === 'prepared' ? 'usage.prepared' : 'usage.checkpointed', { row: value });
    this.store.publishChanges([{ topic: 'usage', id: row.batchId }]);
  }
  private mutate(id: string, change: () => void, name = 'usage.update'): void {
    this.store.command(name, () => {
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
  override started(id: string, threadId: string, turnId: string, start?: () => void): void { this.mutate(id, () => super.started(id, threadId, turnId, start)); }
  override observe(id: string, usage: TokenUsage): void {
    const row=this.read(id);if(row.phase==='final')throw new Error('Final usage cannot be changed');
    if(Date.now()-(this.checkpointAt.get(id)??0)<2000){this.pending.set(id,structuredClone(usage));return;}
    this.persistObservation(id,usage);this.checkpointAt.set(id,Date.now());this.pending.delete(id);
  }
  private persistObservation(id:string,usage:TokenUsage):void {
    this.mutate(id, () => {
      const row = this.get(id), previous = row.cost;
      super.observe(id, usage);
      const book = new PriceBook(this.store);
      const price = book.find(row.provider, row.model, row.startedAt)
        ?? (row.provider === 'fake' ? book.find('claude', row.model, row.startedAt) : null);
      const pinned = previous?.model === row.model ? previous.price : null;
      row.cost = estimateCost(row.model, usage.last, pinned ?? price?.price ?? null);
      if (!pinned) row.priceId = price?.id ?? null;
    });
  }
  flush():void {for(const [id,usage] of this.pending){this.persistObservation(id,usage);this.pending.delete(id);this.checkpointAt.set(id,Date.now());}}
  override abandon(id: string, restore: () => void): void {
    this.store.atomic(() => { this.store.emit('usage.abandoned', { batchId: id }); restore();
      this.store.publishChanges([{ topic: 'usage', id }]); });
    this.pending.delete(id);this.checkpointAt.delete(id);
  }
  override settle(id: string, outcome: string, confirmed: boolean, finish: () => void): void {
    const pending=this.pending.get(id);
    this.store.atomic(()=>{if(pending)this.persistObservation(id,pending);this.mutate(id, () => super.settle(id, outcome, confirmed, finish), 'turn.complete');});
    this.pending.delete(id);this.checkpointAt.delete(id);
  }
  override recover(): void {
    this.store.command('usage.recover', () => {
      for (const row of this.list()) {
        if (row.phase === 'prepared') this.store.emit('usage.abandoned', { batchId: row.batchId });
        else if (row.phase === 'submitted') this.save({ ...row, phase: 'final', outcome: 'interrupted', complete: false });
      }
    });
  }
  acknowledge(id: string, tokens: number, nanoUsd: number, note: string): void {
    if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(nanoUsd) || nanoUsd < 0 || !note.trim()) throw new Error('Provide nonnegative usage bounds and a note');
    if(this.store.db.query('SELECT 1 FROM recovery_usage WHERE execution_id=?').get(id)){
      this.store.command('recovery.usage.resolve',()=>{
        const row=this.recoveryList().find(r=>r.execution_id===id)!;
        if(row.resolution_json)throw new Error('Recovery usage is already resolved');
        const usage=row.usage_json?JSON.parse(row.usage_json):null,cost=row.cost_json?JSON.parse(row.cost_json):null;
        if(tokens<(usage?.last.totalTokens??0)||nanoUsd<(cost?.maximumNanoUsd??0))throw new Error('Bounds cannot reduce observed usage');
        this.store.emit('recovery.usage_resolved',{row:{...row,resolution_json:JSON.stringify({tokens,nanoUsd,note,at:new Date().toISOString()})}});
        this.store.publishChanges([{topic:'usage',id}]);
      });return;
    }
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
    return this.decode(rows).map(row=>{
      const pending=this.pending.get(row.batchId);if(!pending)return row;
      const model=pending.model??row.model;return {...row,model,usage:pending,cost:estimateCost(model,pending.last,row.cost?.price??null)};
    });
  }
  recoveryList(agentId?:string):RecoveryUsageRow[]{
    return agentId===undefined?this.store.db.query<RecoveryUsageRow,[]>('SELECT * FROM recovery_usage ORDER BY recorded_at,execution_id').all():this.store.db.query<RecoveryUsageRow,[string]>('SELECT * FROM recovery_usage WHERE agent_id=? ORDER BY recorded_at,execution_id').all(agentId);
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
      laneId: String(r.lane_key) || null, priceId: r.price_id as string | null, recordedAt: String(r.recorded_at),
    }));
  }
  override totals(agentId: string, calendar: BudgetCalendar, now: number) {
    const window = calendar.window(now);
    const rows = this.store.db.query(`SELECT * FROM usage_records WHERE agent_id = ?
      AND ((recorded_at >= ? AND recorded_at < ?) OR phase <> 'final'
        OR (resolution_json IS NULL AND (complete = 0 OR usage_json IS NULL OR cost_usd IS NULL)))`).all(agentId, new Date(window.start).toISOString(), new Date(window.end).toISOString());
    const recovery=this.recoveryList(agentId).map(r=>({batchId:r.execution_id,agentId:r.agent_id,provider:r.provider,model:r.model,threadId:null,turnId:null,cause:'recovery',deliveryIds:JSON.parse(r.deliveries_json),chainIds:JSON.parse(r.chains_json),phase:'final' as const,outcome:'interrupted',usage:r.usage_json?JSON.parse(r.usage_json):null,cost:r.cost_json?JSON.parse(r.cost_json):null,complete:false,resolution:r.resolution_json?JSON.parse(r.resolution_json):null,startedAt:r.recorded_at,updatedAt:r.recorded_at}));
    const live=this.decode(rows).map(r=>{const p=this.pending.get(r.batchId);return p?{...r,usage:p,cost:estimateCost(p.model??r.model,p.last,r.cost?.price??null)}:r;});
    return totals([...live,...recovery], agentId, calendar, now);
  }
}
