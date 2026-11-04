import { createHash } from 'node:crypto';
import type { Store } from '../store';
import type { PriceRow } from '../store/event-types';
import { canonical } from '../store/events';
import type { ModelPrice } from '../usage/pricing';

export function priceRow(provider: string, price: ModelPrice, effectiveFrom = `${price.verifiedAt}T00:00:00.000Z`): PriceRow {
  if (price.currency !== 'USD' || price.unit !== 'million-tokens') throw new Error('Prices must be USD per million tokens');
  if (!provider.trim() || !price.model.trim() || !price.source.trim() || !Number.isFinite(Date.parse(effectiveFrom))) throw new Error('Invalid price identity');
  for (const rate of [price.input, price.cacheWrite5m, price.cacheWrite1h, price.cacheRead, price.output]) {
    if (!Number.isFinite(rate) || rate < 0 || !Number.isSafeInteger(Math.round(rate * 1000)) || Math.abs(rate * 1000 - Math.round(rate * 1000)) > 1e-7) throw new Error('Prices require nonnegative integral nano-USD per token');
  }
  const snapshot = canonical({ provider, price, effectiveFrom: new Date(effectiveFrom).toISOString() });
  return { id: createHash('sha256').update(snapshot).digest('hex'), provider, model: price.model,
    input_usd: price.input, cache_write_5m_usd: price.cacheWrite5m, cache_write_1h_usd: price.cacheWrite1h,
    cache_read_usd: price.cacheRead, output_usd: price.output, effective_from: new Date(effectiveFrom).toISOString(),
    source_url: price.source, snapshot_json: snapshot };
}
export class PriceBook {
  constructor(private readonly store: Store) {}
  add(provider: string, price: ModelPrice, effectiveFrom?: string): string {
    const row = priceRow(provider, price, effectiveFrom);
    return this.store.command('price.configure', () => {
      const old = this.store.db.query<{ id: string }, [string, string, string]>('SELECT id FROM prices WHERE provider = ? AND model = ? AND effective_from = ?').get(provider, price.model, row.effective_from);
      if (old && old.id !== row.id) throw new Error('A different price already exists at this effective timestamp');
      this.store.emit('price.configured', { row });
      this.store.publishChanges([{ topic: 'prices', id: row.id }]); return row.id;
    }, { id: `price:${row.id}`, input: row });
  }
  find(provider: string, model: string, timestamp: string): { id: string; price: ModelPrice } | null {
    const row = this.store.db.query<PriceRow, [string, string, string]>(
      'SELECT * FROM prices WHERE provider = ? AND model = ? AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1').get(provider, model, timestamp);
    return row ? { id: row.id, price: JSON.parse(row.snapshot_json).price } : null;
  }
}
