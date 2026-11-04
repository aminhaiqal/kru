import type { Database } from 'bun:sqlite';
import { append } from './events';
import { modelPrices, type CostEstimate } from '../usage/pricing';
import { priceRow } from '../cost/prices';
import type { AgentRow, DeliveryRow, MessageRow, UsageRow } from './event-types';

/** Runs inside the migration transaction; imports preserve original ids, seq and timestamps. */
export function importGenesis(db: Database): void {
  const command = 'migration:4:genesis';
  for (const p of Object.values(modelPrices)) append(db, command, 'price.configured', { row: priceRow(p.model === 'fake' ? 'fake' : 'claude', p) }, `${p.verifiedAt}T00:00:00.000Z`);
  for (const row of db.query<AgentRow, []>('SELECT * FROM agents ORDER BY created_at, id').all()) append(db, command, 'agent.configured', { row }, row.created_at);
  // Reply references need the original message insertion order, not a sort on UUIDs.
  for (const row of db.query<MessageRow, []>('SELECT * FROM messages ORDER BY rowid').all()) append(db, command, 'message.imported', { row }, row.created_at);
  for (const row of db.query<DeliveryRow, []>('SELECT * FROM deliveries ORDER BY seq').all()) append(db, command, 'delivery.imported', { row }, row.updated_at);
  for (const old of db.query<UsageRow, []>('SELECT * FROM usage_records ORDER BY started_at, batch_id').all()) {
    const cost = old.cost_json ? JSON.parse(old.cost_json) as CostEstimate : null;
    const count = old.usage_json ? JSON.parse(old.usage_json).last : null;
    let priceId: string | null = null;
    if (cost?.price) { const row = priceRow(old.provider, cost.price); append(db, command, 'price.configured', { row }, old.started_at); priceId = row.id; }
    const deliveryIds = JSON.parse(old.deliveries_json) as string[];
    const lane = deliveryIds.length ? db.query<{ lane_id: string | null }, [string]>('SELECT lane_id FROM deliveries WHERE id = ?').get(deliveryIds[0]!) : null;
    const row: UsageRow = { ...old, lane_key: lane?.lane_id ?? '', price_id: priceId, recorded_at: old.started_at,
      input_total: count?.inputTotal ?? null, cached_read: count?.cachedRead ?? null, cache_write: count?.cacheWrite ?? null,
      cache_write_5m: count?.cacheWriteByLifetime?.fiveMinutes ?? null, cache_write_1h: count?.cacheWriteByLifetime?.oneHour ?? null,
      output: count?.output ?? null, cost_usd: cost?.maximumNanoUsd == null ? null : cost.maximumNanoUsd / 1e9, estimated: 1 };
    append(db, command, 'usage.imported', { row }, old.updated_at);
  }
}
