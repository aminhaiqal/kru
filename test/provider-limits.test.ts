import { expect, test } from 'bun:test';
import { codexLimits, claudeLimits, UsageLimits } from '../src/providers/limits';
import { ClaudeProvider } from '../src/providers/claude/adapter';
import { InputQueue } from '../src/providers/claude/input-queue';

test('Codex quotas preserve actual window lengths, missing windows and multiple buckets', () => {
  const primary = { usedPercent: 0, windowDurationMins: 300, resetsAt: 1800000000 };
  const secondary = { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1800600000 };
  expect(codexLimits({ rateLimits: { primary } })).toEqual([
    {
      id: 'codex:primary',
      label: '5-hour',
      usedPercent: 0,
      windowMinutes: 300,
      resetsAt: new Date(primary.resetsAt * 1000).toISOString(),
    },
  ]);
  const quotas = codexLimits({
    rateLimits: { primary },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary, secondary },
      special: {
        limitId: 'special',
        limitName: 'Special',
        primary: {
          usedPercent: 100,
          windowDurationMins: 60,
          resetsAt: null,
        },
      },
    },
  });
  expect(quotas.map((item) => item.label)).toEqual(['5-hour', 'Weekly', 'Special · 1-hour']);
  expect(codexLimits({ rateLimits: { primary: { usedPercent: null } } })).toEqual([]);
  expect(codexLimits({ rateLimits: null })).toEqual([]);
});

test('Claude plan windows, per-model limits and extra usage are normalized without inventing data', () => {
  const data = {
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 6.5, resets_at: '2026-12-01T10:00:00Z' },
      seven_day: { utilization: 0, resets_at: null },
      seven_day_sonnet: { utilization: 44, resets_at: 'invalid' },
      model_scoped: [{ display_name: 'Opus', utilization: 90, resets_at: null }],
      extra_usage: { is_enabled: true, utilization: 12 },
    },
  };
  const limits = claudeLimits(data);
  expect(limits.map((item) => item.usedPercent)).toEqual([6.5, 0, 44, 90, 12]);
  expect(limits.map((item) => item.windowMinutes)).toEqual([300, 10080, 10080, 10080, null]);
  expect(limits[2]?.resetsAt).toBeNull();
  expect(claudeLimits({ ...data, rate_limits_available: false })).toEqual([]);
  expect(claudeLimits({ rate_limits_available: true, rate_limits: { five_hour: null } })).toEqual(
    [],
  );
});

test('Quota reads coalesce, cache metadata and return unavailable on failure', async () => {
  let calls = 0;
  const limits = new UsageLimits(async (id) => {
    calls++;
    await Bun.sleep(5);
    if (id === 'claude') throw new Error('Private credential details must not reach the UI');
    return codexLimits({
      rateLimits: {
        primary: {
          usedPercent: 23,
          windowDurationMins: 300,
          resetsAt: 1800000000,
        },
      },
    });
  });
  const [a, b] = await Promise.all([limits.read('codex'), limits.read('codex')]);
  expect(calls).toBe(1);
  expect(a).toEqual(b);
  a.windows[0]!.usedPercent = 99;
  expect((await limits.read('codex')).windows[0]?.usedPercent).toBe(23);
  expect(calls).toBe(1);
  const failure = await limits.read('claude');
  expect(failure.status).toBe('unavailable');
  expect(failure.windows).toEqual([]);
  expect(JSON.stringify(failure)).not.toContain('Private');
  limits.invalidate('codex');
  await limits.read('codex');
  expect(calls).toBe(3);
});

test('An account change during a quota read discards the previous account result', async () => {
  let resolve!: (value: any[]) => void;
  const limits = new UsageLimits(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = limits.read('codex');
  limits.invalidate('codex');
  resolve(codexLimits({ rateLimits: { primary: { usedPercent: 22 } } }));
  expect((await pending).windows).toEqual([]);
});

test('Claude quota query reads metadata with no user input and does not persist a session', async () => {
  let options: any, usageOptions: any, input: any;
  const output = new InputQueue<any>();
  const provider = new ClaudeProvider({
    query: (args) => {
      options = args.options;
      input = args.prompt;
      return {
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        close: () => output.close(),
        interrupt: async () => {},
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (opts: any) => {
          usageOptions = opts;
          return {
            rate_limits_available: true,
            rate_limits: {
              five_hour: { utilization: 17, resets_at: null },
            },
          };
        },
      };
    },
  });
  await provider.start();
  try {
    expect((await provider.usageLimits())[0]?.usedPercent).toBe(17);
    expect(options.persistSession).toBe(false);
    expect(usageOptions).toEqual({ skipBehaviors: true });
    expect(await input[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
  } finally {
    await provider.stop();
  }
});
