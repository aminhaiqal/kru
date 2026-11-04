# Next profile benchmark: controlled repeated blocks

The runner is implemented in `scripts/claude-profile-benchmark.ts`. It prepares
its plan without making model calls unless `--run` is present:

```sh
bun run benchmark:claude-profiles --plan
bun run benchmark:claude-profiles --run --pairs 5 --models claude-sonnet-4-6,claude-sonnet-5-5
```

The default plan is five blocks on each of two models: **40 measured runs plus
40 warm-ups**. Executing it consumes the existing Claude login's quota.
The [2026-11-04 execution](claude-profiles-2026-11-04/README.md) completed 38
measured runs, all passing acceptance; two final attempts hit the account limit.
The report retains the incomplete counts and an excluded warm-up protocol attempt.

Sonnet 5.5 is in the [current Anthropic model lineup](https://platform.claude.com/docs/en/models/overview),
verified 2026-11-04. Sonnet 4.6 remains the legacy comparison. Model IDs, CLI/SDK
versions, actual served models and pricing snapshots are retained with the run.
Availability/account errors stop further samples for that model, preserve the
failure, and leave the dataset explicitly incomplete rather than silently retrying
until a favorable result appears.

## Factors and order

| Variant | System prompt | Native tools | Settings sources | Client-composed input |
| --- | --- | --- | --- | --- |
| full-controlled | Claude Code preset | Full preset | none | yes |
| full-restricted | Claude Code preset | Six coding tools | none | yes |
| lean-full | Kru coding prompt | Full preset | none | yes |
| coding | Kru coding prompt | Six coding tools | none | yes |

This is a blocked 2×2 prompt/tool experiment. Project settings, context composition,
permissions, auto-memory disabling, fixture and task are constant across treatments.
`full-controlled` therefore differs from the production `full` profile, which
loads settings and native context attachments. This deliberate normalization
isolates the prompt and tool-list effects; it is not a rerun of the old bundle.
The current `coding` treatment remains unchanged in those normalized dimensions.
Settings-source/context effects need a subsequent separate experiment.

Blocks alternate forward/reverse order:

```
1: full-controlled → full-restricted → lean-full → coding
2: coding → lean-full → full-restricted → full-controlled
...
```

There are at least five paired observations of each contrast per model. Reusing
the four samples in a block supports both tool-only and prompt-only contrasts.
The full-controlled/coding contrast changes both factors and has no single-factor
causal interpretation. Five blocks leave one more forward than reverse block;
the complete order is stored, and a larger even block count can balance it exactly.

## Cache protocol

Each fresh session first receives a fixed READY-only prompt that prohibits tools
and edits. Its usage/cost is recorded separately. The original duration-parser
task is then measured in that same session, with no fixture mutation permitted
between warm-up and measurement. Measured latency excludes startup, warm-up and
shutdown; those conditions differ from the old elapsed-time measurement.

A unique marker in the user prompt alone cannot establish a cold cache:
Anthropic's [cache hierarchy](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#structuring-your-prompt)
places tools and system content before user messages. This protocol chooses an
explicit warm-up rather than claiming a cold cache. Actual cache reads, writes
and lifetime counters are recorded; observed hits are not assumed from the protocol.
External cache eviction and provider behavior remain possible sources of variation.

## Measurement and reporting

For every run preserve the source, prompt/options, raw events, reply, generated
implementation, protected-fixture comparison and independent unchanged acceptance
log. A failed acceptance check remains a failed sample, even if its costs are low.
Warm-up violations are recorded as failures. No measured sample can silently use
a different requested model.

`results.json` and `summary.md` report per-model/per-treatment sample counts,
acceptance counts, median and range for inclusive input, cache reads/writes, output,
total tokens, measured turn latency, model steps, tool calls and SDK-estimated USD.
The JSON also reports main-token list-price bounds, cache-write lifetimes and
unknown counts. Missing metrics retain `n = 0`, not a fabricated zero.

Model steps count unique main-agent assistant message IDs across streamed and
final SDK events. Tool calls count unique tool-use IDs; duplicate events do not
inflate either measure. These directly test the more-steps hypothesis. Native SDK
`num_turns` and per-model cumulative usage are retained as additional evidence.
SDK cost for the measured turn is the query's cumulative estimated cost minus
its post-warm-up baseline, not the sum of cumulative results. That estimate covers
the SDK query pipeline and differs from the separately labeled main-token price
estimate. Neither is an invoice.

The fixture is the same small duration-parser repair as the first pair. Replication
reduces order noise; it does not turn one task into evidence for general coding
quality. Do not promote `coding` to a default or advertise cost savings before the
new measured results support that claim.
