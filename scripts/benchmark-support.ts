import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { CostEstimate } from '../src/usage/pricing';
import type { TokenUsage } from '../src/providers/protocol';
import { PROMPT_PROFILES } from '../src/providers/prompt-profile';

export const variants = ['full-controlled', 'full-restricted', 'lean-full', 'coding'] as const;
export type Variant = typeof variants[number];
export const restrictedTools = ['Read', 'Edit', 'Bash', 'Write', 'Glob', 'Grep'];
export function treatment(variant: Variant): Pick<Options, 'systemPrompt' | 'tools' | 'settingSources'> {
  return {
    systemPrompt: variant === 'full-controlled' || variant === 'full-restricted'
      ? { type: 'preset', preset: 'claude_code' } : PROMPT_PROFILES.coding,
    tools: variant === 'full-controlled' || variant === 'lean-full'
      ? { type: 'preset', preset: 'claude_code' } : [...restrictedTools],
    settingSources: [],
  };
}
export function schedule(models: string[], pairs: number) {
  if (!Number.isSafeInteger(pairs) || pairs < 5) throw new Error('At least five paired blocks are required');
  return models.flatMap(model => Array.from({ length: pairs }, (_, index) => {
    const order = index % 2 ? [...variants].reverse() : [...variants];
    return order.map((variant, position) => ({ model, block: index + 1, position: position + 1, variant }));
  }).flat());
}
export function distribution(values: number[]) {
  if (!values.length) return { n: 0, median: null, minimum: null, maximum: null };
  if (!values.every(Number.isFinite)) throw new Error('Invalid benchmark sample');
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { n: sorted.length, median, minimum: sorted[0]!, maximum: sorted.at(-1)! };
}
export interface BenchmarkRow {
  model: string; block: number; variant: Variant; passed: boolean; usage?: TokenUsage;
  cost?: CostEstimate; elapsedMs?: number; nativeEstimatedUsd?: number; error?: string;
}
export function measurementsComplete(rows: BenchmarkRow[], expected: number): boolean {
  return rows.length === expected && rows.every(r => r.usage !== undefined && r.elapsedMs !== undefined);
}
export function isAccountOrAvailabilityError(message: string): boolean {
  return /not found|not available|not authorized|authentication|login|rate.limit|quota|unknown model|Requested .*received|hit your .*limit|usage limit/i.test(message);
}
export function summarize(rows: BenchmarkRow[], expected: number) {
  return [...new Set(rows.map(r => r.model))].flatMap(model => variants.map(variant => {
    const all = rows.filter(r => r.model === model && r.variant === variant);
    const metrics: Record<string, ReturnType<typeof distribution>> = {};
    const values = (read: (r: BenchmarkRow) => number | undefined) => distribution(all.map(read).filter((v): v is number => v !== undefined));
    metrics.elapsedMs = values(r => r.elapsedMs); metrics.modelSteps = values(r => r.usage?.modelSteps);
    metrics.toolCalls = values(r => r.usage?.toolCalls); metrics.inputTotal = values(r => r.usage?.last.inputTotal);
    metrics.cacheRead = values(r => r.usage?.last.cachedRead); metrics.cacheWrite = values(r => r.usage?.last.cacheWrite);
    metrics.cacheWrite5m = values(r => r.usage?.last.cacheWriteByLifetime?.fiveMinutes);
    metrics.cacheWrite1h = values(r => r.usage?.last.cacheWriteByLifetime?.oneHour);
    metrics.mainCostMinimumUsd = values(r => r.cost?.minimumNanoUsd == null ? undefined : r.cost.minimumNanoUsd / 1e9);
    metrics.mainCostMaximumUsd = values(r => r.cost?.maximumNanoUsd == null ? undefined : r.cost.maximumNanoUsd / 1e9);
    metrics.output = values(r => r.usage?.last.output); metrics.totalTokens = values(r => r.usage?.last.totalTokens);
    metrics.nativeEstimatedUsd = values(r => r.nativeEstimatedUsd);
    return { model, variant, expected, attempted: all.length, passed: all.filter(r => r.passed).length,
      failed: all.filter(r => !r.passed).length, complete: all.length === expected && all.every(r => r.usage !== undefined), metrics };
  }));
}

export function markdownReport(rows: BenchmarkRow[], expected: number): string {
  const stats = summarize(rows, expected);
  const cell = (d: ReturnType<typeof distribution>, scale = 1) => d.n === 0 ? 'n/a' :
    `${(d.median! / scale).toFixed(3)} [${(d.minimum! / scale).toFixed(3)}, ${(d.maximum! / scale).toFixed(3)}]`;
  const lines = ['# Profile benchmark', '', 'Cells show median [minimum, maximum]. Warm-ups are excluded. Missing metrics retain their sample counts in results.json.', '',
    'full-controlled uses the full prompt/tool presets with settings and client composition normalized to coding. It is not the native production full profile.', ''];
  for (const model of [...new Set(stats.map(s => s.model))]) {
    lines.push(`## ${model}`, '', '| Variant | Acceptance | Input | Cached reads | Cache writes | Output | Model steps | Tool calls | Seconds | SDK estimated USD |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of stats.filter(s => s.model === model)) {
      lines.push(`| ${r.variant} | ${r.passed}/${r.attempted} attempted; ${r.expected} planned | ${cell(r.metrics.inputTotal!)} | ${cell(r.metrics.cacheRead!)} | ${cell(r.metrics.cacheWrite!)} | ${cell(r.metrics.output!)} | ${cell(r.metrics.modelSteps!)} | ${cell(r.metrics.toolCalls!)} | ${cell(r.metrics.elapsedMs!, 1000)} | ${cell(r.metrics.nativeEstimatedUsd!)} |`);
    }
    lines.push('');
  }
  lines.push('Incomplete blocks and failures are retained. No generalized quality/cost claim follows from a partial run. SDK dollar estimates cover its query pipeline; main-token list-price bounds and cache lifetimes are recorded separately.');
  return lines.join('\n') + '\n';
}
