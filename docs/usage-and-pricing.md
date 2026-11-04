# Durable usage, pricing and budgets

The first M4 foundation is implemented: daemon turn usage and estimated token
costs survive restarts, with token and USD gates backed by the same ledger.
The subsequent [M4 implementation](m4.md) adds event replay, durable assistant
messages, `kru log` and grouped cost reports.
Standalone scheduler consumers must inject a persistent `UsageLedger`; its default
in-memory implementation is for fixtures. The daemon supplies SQLite by default.

```sh
bun run dev -- agent create coder --provider claude --model claude-sonnet-5-5 --prompt-profile full
bun run dev -- agent set coder --daily-tokens 200000 --daily-usd 2.00
bun run dev -- cost
bun run dev -- cost --agent coder --json
```

Both limits apply. A zero limit holds new work. Increasing one limit does not
bypass the other. USD gates use the conservative upper cost bound. A dollar-limited
agent needs an explicit model with a known rate; missing prices are a hold, not free
work. The generic profile default stays `minimal`; `coding` remains explicit opt-in.
For Claude coding work, use `full` as the comparison baseline rather than promoting
`coding` on the strength of one token-reduction observation. Codex does not support
the Claude-only `full` profile.

## Price snapshots and scope

`src/usage/pricing.ts` contains a dated table of standard first-party Claude API
rates, verified against [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
on 2026-11-04. Each model has separate uncached input, cache-read, five-minute
cache-write, one-hour cache-write and output rates. Initial supported price rows
are Sonnet 4.6, Sonnet 5.5, Opus 5.5, Fable 5.1 and the free deterministic fake.
Unknown models remain unpriced; there is no fuzzy family-name fallback.

For the normalized inclusive input count:

```
uncached input = inputTotal - cachedRead - cacheWrite
USD = uncached × input rate + reads × read rate
    + 5m writes × 5m rate + 1h writes × 1h rate + output × output rate
```

Rates are USD per million tokens. Computation uses integral nano-USD to avoid
rounding a small budget to zero. Cache counts are not added to inclusive input a
second time. Claude's optional lifetime breakdown is preserved in usage records.
If the breakdown omits some writes, those tokens produce lower/upper bounds using
the two write rates. The upper bound is used for budget decisions.

These are **estimated main-agent token costs**, using the same per-turn scope as
`usage.last`. They are not an invoice or a subscription quota conversion. Auxiliary
model calls, subagents, tool/service fees, negotiated prices, fast-mode premiums
and partner/cloud pricing are not included. The scope is explicit in stored
estimates and CLI output. Full query-pipeline accounting requires per-model native
counter baselines, including across resumed sessions, and remains a separate
accounting follow-up.
Do not present this estimated USD limit as a hard cap on all account charges.

Every stored estimate includes its original model/rate snapshot and verification
date. Migration v4 adds the immutable `prices` projection and per-turn `price_id`;
`PriceBook` adds new effective rates without repricing historical finalized turns.
Missing prices or usage are visible in `kru cost`; partial totals are labeled.

## Ledger lifecycle

Schema v3 adds one `usage_records` row per claimed batch, with native thread/turn
ids, agent/provider/model, cause, delivery/chain references, token snapshots, cost
bounds, completion state and optional person-supplied resolution bounds.

A prepared row exists before execution. `submitted` is persisted before sending
`turn/start`; each usage update replaces the latest snapshot rather than adding
cumulative snapshots. On confirmed completion, usage finalization and every
batch member's final transition share one transaction. M4 includes final items,
turn metadata and lane release in that same dispatch. A rollback appends no
events and publishes no notifications. `Store.atomic` now routes through dispatch;
nested commands use savepoints, while ordinary nested `Store.write` calls remain refused.

Boot recovery discards prepared rows whose turn was never submitted, and preserves
submitted unknown outcomes as interrupted/incomplete. Known usage and price
snapshots survive restart. Incomplete consumption holds a configured budget rather
than being assumed zero. A person can review and supply conservative bounds:

```sh
bun run dev -- cost acknowledge <batch-id> --tokens 10000 --usd 0.25 --note "reviewed interrupted run"
```

This records an explicit, dated estimate alongside the original evidence; it does
not retry the turn. A finalized record can be acknowledged only once, and supplied
bounds cannot reduce its observed token/cost upper bounds. Ledger changes wake the
scheduler through the Store bus; another CLI connection wakes it through
`data_version`.

Daily windows use the configured budget timezone and include DST. Finalized turns
are attributed to their start day. Pending turns remain reservations even across
midnight until settled. Interrupted consumption that is still unresolved also
keeps its conservative hold across midnight and restarts. Accounting timestamps
remain UTC; changing the selected timezone changes calendar query boundaries,
not the stored timestamp or historical estimate.

## Evidence and M4 integration

`test/usage-ledger.test.ts` covers restart persistence, both budget gates,
repeated-restart unknown holds, missing prices, atomic rollback, duplicate usage
snapshots and explicit resolution. `test/pricing.test.ts` covers cache lifetimes,
missing-lifetime bounds and the archived comparison. Frozen v1/v2/v3/v4 fixtures
cover schema parity and preserved price snapshots.

The completed [M4](m4.md) adds the general event/command-receipt system,
projection replay, durable messages, immutable effective price rows and grouped
cost views. Its twelve acceptance cases pass in ten repeated runs. Main-agent
token estimates still carry the scope limitations described above.

Verified with Bun 1.4.4 on 2026-11-04: `bun run check` passed TypeScript and
228 tests (9 opt-in tests skipped); `bun run test:scheduler:repeat` passed all
670 checks across ten repetitions. `--plan` was checked without creating a
benchmark workspace or starting a native model session.

The subsequent [2026-11-04 live benchmark](benchmarks/claude-profiles-2026-11-04/README.md)
completed 38 measured runs, each passing 26/26 acceptance tests. Two final
Sonnet 5.5 attempts hit the five-hour account limit. Recorded SDK estimates total
$4.901479 for completed measured turns and $0.722695 for warm-ups; the report also
accounts for the excluded protocol attempt and unknown partial usage. Coding's
cost trade-off differed by model, so it remains opt-in.
