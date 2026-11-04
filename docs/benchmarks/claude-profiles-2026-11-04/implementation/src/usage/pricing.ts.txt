import type { TokenCount } from '../providers/protocol';

export interface ModelPrice {
  model: string; input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number;
  source: string; verifiedAt: string; currency: 'USD'; unit: 'million-tokens';
}
const source = 'https://platform.claude.com/docs/en/about-claude/pricing';
const price = (model: string, input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number): ModelPrice =>
  ({ model, input, cacheWrite5m, cacheWrite1h, cacheRead, output, source, verifiedAt: '2026-11-04', currency: 'USD', unit: 'million-tokens' });
/** First-party standard API list prices; no batch, residency, fast-mode or negotiated discounts. */
export const modelPrices: Readonly<Record<string, ModelPrice>> = Object.freeze(Object.fromEntries([
  price('claude-sonnet-4-6', 3, 3.75, 6, .30, 15),
  price('claude-sonnet-5-5', 2, 2.50, 4, .10, 10),
  price('claude-opus-5-5', 4, 5, 8, .20, 20),
  price('claude-fable-5-1', 10, 12.50, 20, .25, 50),
  { ...price('fake', 0, 0, 0, 0, 0), source: 'Kru deterministic fake: no model calls' },
].map(p => [p.model, Object.freeze(p)])));
export interface CostEstimate {
  model: string; minimumNanoUsd: number | null; maximumNanoUsd: number | null;
  unknownCacheWriteTokens: number; price: ModelPrice | null;
  estimated: true; scope: 'main-agent-token-usage';
}
export function nanoUsd(dollars: number): number {
  const value = Math.round(dollars * 1_000_000_000);
  if (!Number.isFinite(dollars) || dollars < 0 || !Number.isSafeInteger(value)) throw new Error('Invalid USD amount');
  return value;
}
export function estimateCost(model: string, count: TokenCount): CostEstimate {
  const p = modelPrices[model] ?? null;
  const writes5m = count.cacheWriteByLifetime?.fiveMinutes ?? 0, writes1h = count.cacheWriteByLifetime?.oneHour ?? 0;
  const unknown = count.cacheWrite - writes5m - writes1h;
  if (![count.inputTotal, count.cachedRead, count.cacheWrite, count.output, writes5m, writes1h].every(n => Number.isSafeInteger(n) && n >= 0)
      || unknown < 0 || count.inputTotal < count.cachedRead + count.cacheWrite) throw new Error('Invalid usage for pricing');
  const result: CostEstimate = { model, minimumNanoUsd: null, maximumNanoUsd: null, unknownCacheWriteTokens: unknown,
    price: p, estimated: true, scope: 'main-agent-token-usage' };
  if (!p) return result;
  const cost = (unknownRate: number) => {
    // Listed rates have integral nano-USD per token. Integer arithmetic avoids budget rounding errors.
    const value = (count.inputTotal - count.cachedRead - count.cacheWrite) * Math.round(p.input * 1000)
      + count.cachedRead * Math.round(p.cacheRead * 1000) + count.output * Math.round(p.output * 1000)
      + writes5m * Math.round(p.cacheWrite5m * 1000) + writes1h * Math.round(p.cacheWrite1h * 1000)
      + unknown * Math.round(unknownRate * 1000);
    if (!Number.isSafeInteger(value)) throw new Error('Cost exceeds supported precision');
    return value;
  };
  result.minimumNanoUsd = cost(Math.min(p.cacheWrite5m, p.cacheWrite1h));
  result.maximumNanoUsd = cost(Math.max(p.cacheWrite5m, p.cacheWrite1h));
  return result;
}
