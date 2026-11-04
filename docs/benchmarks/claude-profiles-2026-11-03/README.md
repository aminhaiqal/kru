# Claude profile comparison — first paired observation

Both profiles passed the same 26 acceptance tests. Coding used 39.2% fewer input
and 34.1% fewer total tokens in this pair, while taking 61.4% longer and writing
more cache tokens. This is not evidence of a monetary saving or broad quality parity.

| Measurement | full | coding |
| --- | ---: | ---: |
| Input total | 161,579 | 98,257 |
| Cache reads (included in input) | 147,055 | 66,954 |
| Cache writes (included in input) | 14,515 | 31,295 |
| Output | 8,697 | 13,896 |
| Total tokens | 170,276 | 112,153 |
| Uncached input (derived) | 9 | 8 |
| Native tools advertised | 33 | 6 |
| Kru-declared tools | 0 | 0 |
| Recorded tool invocations | 8 | 7 |
| Model steps | not archived | not archived |
| Elapsed including startup and shutdown | 110.742 s | 178.775 s |
| Independent acceptance | 26/26 | 26/26 |
| Acceptance tests unchanged | yes | yes |

The table uses `usage.last`, the SDK's per-turn counters summed across the task's
model/tool loop. Cache reads and writes are subsets of input, not extra input.
Cumulative native session totals were 171,636 and 113,513 tokens respectively;
the raw record retains both sets of counters. The extra session usage is not
silently attributed to this turn or dropped from the evidence.

## Method

Run on 2026-11-03 with Claude Sonnet `claude-sonnet-4-6`, SDK 0.3.317 and native
Claude Code 2.1.317. `full` then `coding` ran sequentially in fresh sessions and
separate workspaces copied from the same fixture. Each had the same task text,
CLAUDE.md, project settings, model and writable/on-request configuration. The host
accepted tool approvals for both. Auto memory was disabled for both. The completed
pair is reported; an earlier preflight was cancelled while correcting full-profile
context attachment configuration and is excluded.

The task repairs a deliberately broken TypeScript duration parser and adds compound
h/m/s/ms parsing with ordering, full-input validation and safe-integer checks.
The prompt, original source, acceptance tests, CLAUDE.md and settings are recorded
verbatim in [task.json](task.json). Both agents read the same project instructions,
implemented the fix and ran tests; the host independently reran unchanged tests.
The generated implementations were preserved without manual changes.

`full` uses the `claude_code` prompt and standard tool presets, project/local
settings, and normal CLI context attachments. `coding` uses Kru's custom coding
prompt, six explicit built-ins, no filesystem settings, and client-composed input.
Its explicit Read of CLAUDE.md makes the project instructions available during
this task even without automatic loading. No Kru tools were registered.

## Evidence and reproduction

- [Raw usage, replies, initialization and tool events](results.json)
- [Full implementation](full-duration.ts.txt) and [test log](full-acceptance.log)
- [Coding implementation](coding-duration.ts.txt) and [test log](coding-acceptance.log)
- [Benchmark runner](../../../scripts/claude-profile-benchmark.ts)

The runner has since been upgraded to the [repeated factorial protocol](../profile-factorial-protocol.md).
`bun run benchmark:claude-profiles --plan` previews it; `--run` makes live calls
and writes fresh evidence under `.kru/benchmarks/`. The archived one-pair evidence
above is unchanged; the new controlled baseline has explicitly different context settings.

This is one small task and one ordered pair, not a statistical savings estimate.
Provider caching was observed, not reset or controlled across runs; output length,
reasoning, tool choices and request count also vary. The profiles differ in
several settings together, so the observed difference cannot be assigned solely
to system-prompt length. Passing 26 functional tests does not prove equivalent
coding quality on larger repositories. Cache write counts increased from 14,515
to 31,295; pricing reads, writes and output separately is necessary before making
any cost-saving claim.


## Retrospective token-price estimate — 2026-11-04

Using the standard first-party Sonnet 4.6 rates listed on
[Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing)
on 2026-11-04, the recorded main-agent token usage gives:

| Profile | Estimated USD range |
| --- | ---: |
| full | $0.229030–$0.261689 |
| coding | $0.345906–$0.416320 |

The write lifetimes were not retained, so the bounds price unspecified writes
between the 5-minute and 1-hour rates. Even the upper full estimate is below the
lower coding estimate. Full was faster and had a lower estimated main-token cost
in this pair, despite coding's lower total token count. This is why coding stays
opt-in rather than becoming a default based on token count alone.

These are retrospective list-price calculations, not observed invoices or
subscription quota costs. Auxiliary model calls/tool charges are excluded. The
[calculation artifact](cost-estimate-2026-11-04.json) retains rates, scope and raw
bounds; it makes no new model calls and does not alter the original results.

The archived tool events contain eight invocations for full and seven for coding.
Assistant message IDs were not retained, so model steps cannot be reconstructed.
The more-steps explanation remains a hypothesis for the next instrumented run.
