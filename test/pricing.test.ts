import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { estimateCost, nanoUsd } from '../src/usage/pricing';
import { claudeTokens } from '../src/providers/token-usage';
import { distribution, schedule, summarize, treatment, measurementsComplete, isAccountOrAvailabilityError } from '../scripts/benchmark-support';

test('pricing separates uncached input, cache lifetimes, cache reads and output without double counting', () => {
  const usage = claudeTokens({ input_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 80,
    cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 50 }, output_tokens: 30 });
  const cost = estimateCost('claude-sonnet-4-6', usage);
  expect(cost.minimumNanoUsd).toBe(937500); expect(cost.maximumNanoUsd).toBe(937500);
  expect(cost.unknownCacheWriteTokens).toBe(0); expect(cost.price!.verifiedAt).toBe('2026-11-04');
  expect(() => claudeTokens({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1,
    cache_creation: { ephemeral_1h_input_tokens: 2 } })).toThrow();
});

test('missing cache lifetimes produce bounds; unknown models are unpriced, never zero', () => {
  const usage = claudeTokens({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 100 });
  expect(estimateCost('claude-sonnet-4-6', usage)).toMatchObject({ minimumNanoUsd: 375000, maximumNanoUsd: 600000, unknownCacheWriteTokens: 100 });
  expect(estimateCost('unpriced-model', usage).maximumNanoUsd).toBeNull();
  expect(() => nanoUsd(-1)).toThrow(); expect(nanoUsd(.000000001)).toBe(1);
});

test('the archived full run has a lower main-token cost even across unknown write lifetimes', () => {
  const archive = JSON.parse(readFileSync(new URL('../docs/benchmarks/claude-profiles-2026-11-03/results.json', import.meta.url), 'utf8'));
  const [full, coding] = archive.rows.map((r: { usage: { last: Parameters<typeof estimateCost>[1] } }) => estimateCost(archive.model, r.usage.last));
  expect(full.maximumNanoUsd).toBeLessThan(coding.minimumNanoUsd);
});

test('the factorial schedule has five counterbalanced pairs per model and isolates prompt/tool factors', () => {
  const runs = schedule(['old', 'current'], 5);
  expect(runs).toHaveLength(40);
  expect(runs.filter(r => r.model === 'old' && r.block === 1).map(r => r.variant)).toEqual(['full-controlled', 'full-restricted', 'lean-full', 'coding']);
  expect(runs.filter(r => r.model === 'old' && r.block === 2).map(r => r.variant)).toEqual(['coding', 'lean-full', 'full-restricted', 'full-controlled']);
  expect(treatment('full-controlled').systemPrompt).toEqual(treatment('full-restricted').systemPrompt);
  expect(treatment('full-controlled').tools).toEqual(treatment('lean-full').tools);
  expect(treatment('coding').settingSources).toEqual(treatment('full-controlled').settingSources);
  expect(() => schedule(['m'], 4)).toThrow('At least five');
});

test('reports include failures and sample counts with medians and ranges', () => {
  expect(distribution([5, 1, 9, 3, 7])).toEqual({ n: 5, median: 5, minimum: 1, maximum: 9 });
  expect(distribution([1, 3]).median).toBe(2);
  const summary = summarize([{ model: 'm', block: 1, variant: 'coding', passed: false, elapsedMs: 10 }], 5).find(r => r.variant === 'coding')!;
  expect(summary.failed).toBe(1); expect(summary.complete).toBe(false); expect(summary.metrics.elapsedMs!.n).toBe(1);
  // An attempted quota failure is not a completed measurement.
  expect(measurementsComplete([{ model: 'm', block: 1, variant: 'coding', passed: false }], 1)).toBe(false);
  expect(isAccountOrAvailabilityError("You've hit your 5-hour limit · resets 1:50am (Asia/Kuala_Lumpur)")).toBe(true);
  expect(isAccountOrAvailabilityError('Warm-up changed the fixture')).toBe(false);
});

test('benchmark plan mode makes no workspace or native model session', async () => {
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const cwd = mkdtempSync(join(tmpdir(), 'kru-benchmark-plan-'));
  try {
    const child = Bun.spawn([process.execPath, new URL('../scripts/claude-profile-benchmark.ts', import.meta.url).pathname,
      '--plan', '--models', 'claude-sonnet-4-6,claude-sonnet-5-5'], { cwd, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0); expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({ measuredRuns: 40, warmupRuns: 40, execution: false });
    expect(JSON.parse(stdout).warmupPrompt).toContain('This turn');
    expect(JSON.parse(stdout).warmupPrompt).not.toContain('task that follows');
    expect(existsSync(join(cwd, '.kru'))).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
