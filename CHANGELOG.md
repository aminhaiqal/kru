# Changelog

## Unreleased

### Added

- M5 daemon tool routing for `list_agents` and `send_message`, with durable
  namespaced native-call receipts and no waiting for recipient turns.
- Opt-in automatic answers returning to the sender lane, manual-answer
  deduplication and forced reply-off behavior on answers.
- Default four-hop chain limit with `--max-hops`, preserving chain cost attribution
  and reserving a hop for a requested answer.
- Migration v5 routing/reply events and projections, frozen upgrade fixtures,
  scripted Codex/Claude integration tests and a deterministic two-agent demo.
- Migration v6 indexed 30-day mailbox-key retention, pinned while any original
  or retry attempt is open, with bounded maintenance and safe concurrent reuse.
- A 1 MiB mailbox storage input limit and bounded, redacted provider error strings
  in new delivery/turn events, daemon status and command receipt fingerprints.

### Changed

- Claude tool ids use MCP request ids where available, enabling repeat callbacks
  to find the same durable receipt.

## [0.0.6] - 2026-11-04

M4 — event log, replayable projections, durable conversation history and cost accounting.

### Added

- M4 append-only, versioned domain events and durable command receipts, with
  deterministic projectors and atomic end-of-turn answer/accounting commits.
- Migration v4 genesis imports for existing agents, messages, delivery seq order
  and usage, preserving shipped v1–v3 migrations and historical price snapshots.
- Durable daemon conversation items, turn metadata and two-second partial scratch
  snapshots; `log [--follow]`, `replay --verify` and cost grouping/time filters.
- Immutable effective model-price rows and per-turn price ids; unknown prices
  remain NULL and unresolved consumption keeps its budget hold across midnight.
- All twelve M4 acceptance cases, ten repeated runs, cross-process command
  deduplication, completion/migration fault injection and a frozen v4 fixture.

## [0.0.5] - 2026-11-04

M3 — lanes and the drain scheduler, with lifecycle follow-ups, the first M4
durable usage/budget foundation and controlled profile benchmark evidence.

### Added

- Durable per-turn usage/cost ledger, atomic usage/batch completion, dated model
  prices with cache-lifetime bounds, `cost` and combined token/`--daily-usd` gates.
- Per-turn Claude model-step/tool-call instrumentation and retained cache-write
  lifetime counts.
- Repeated four-treatment benchmark with at least five alternating blocks,
  warm-ups, legacy/current models, raw evidence and median/range reports.
  `--plan` is non-billable; `--run` executes real model calls.
- Archived 2026-11-04 live evidence: 38 measured runs passed 26/26 acceptance
  tests; two final Sonnet 5.5 attempts hit the account limit. Median/range and
  paired comparisons retain missing samples and the excluded protocol attempt.

- M3 daemon with process-identity ownership, startup interruption of abandoned
  work, cross-process database polling and graceful/forced signal shutdown.
- Atomic batch claims and lane reservations in schema v2, plus persisted native
  session bindings and daemon status snapshots.
- Lane scheduling with lost-wakeup rechecks, user-first capacity allocation,
  ordered holds, daily token gates and bounded user-message batching.
- Turn runner that retains unknown starts through their grace period, handles
  late confirmation and retires uncertain native threads before lane release.
  Codex tombstones abandoned threads and probes shared-server liveness without
  interrupting healthy peers; Claude retains per-thread process termination.
- `daemon`, `status`, `agent set`, `agent pause` and `agent resume` commands.
- All 12 M3 acceptance cases, real process contention/crash/signal tests, frozen
  schema-v2 coverage and `test:scheduler:repeat` for ten repeated runs.

### Changed

- Mailbox adapters and agent registries sharing one Store connection publish
  committed changes on one bus, so configuration changes wake the scheduler.
- Heartbeats run every ten seconds; unchanged status snapshots skip writes.
- Budget days follow local time by default, with a `--budget-timezone` override.
- Boot recovery preserves native session bindings and tries resume before replacing
  missing caches. The first M4 foundation now persists token and estimated-USD budgets.

## [0.0.4] - 2026-11-04

M2 — the durable mailbox, project discovery and CLI, plus interactive chat approvals.

### Added

- M2 durable mailbox port and SQLite adapter with independent messages/deliveries,
  transactional idempotency, atomic lane claims and sequence-based queue order.
- Central delivery state machine, final-state immutability, explicit retry lineage
  and change notifications published after commit.
- Project discovery by ancestor `.kru/`, explicit `init`, and database overrides,
  preventing accidental empty mailboxes when running commands from subfolders.
- Persistent agent registry and `agent create`, `agent list`, `send`, `queue`,
  `cancel` and `retry` commands, with configurable database paths.
- Version-1 migrations, WAL/full synchronization, busy timeout, foreign-key
  validation and a frozen schema fixture with migration parity coverage.
- All 13 M2 acceptance cases, process contention checks and CLI integration tests;
  `test:mailbox:repeat` repeats the M2 suite ten times.
- Interactive command/file approval prompts for `kru chat` with `on-request`.
  Show action details on stderr and accept explicit `y`/`yes` for one action.
- Shared terminal input routing for chat and approval answers, with sequential
  prompts, default refusal, EOF handling, cancellation and deadline cleanup.
- Regression tests for approval decisions, non-terminal/never refusal, queued
  requests, pretyped consent and terminal control escaping.
- Codex native-peer approval regression and real-terminal yes/no/Ctrl+C evidence,
  with a documented command for exercising explicit Codex approvals.

## [0.0.3] - 2026-11-03

M1 — one provider port with fake, Codex and Claude adapters.

### Added

- Typed thread/turn methods, notifications, tool calls, approval replies,
  capabilities and lifecycle events shared by all adapters.
- Claude Agent SDK adapter with generated turn IDs, streaming input queues,
  end-of-turn usage and in-process MCP tools.
- Codex app-server adapter with dynamic tools and one shared process for agents,
  independent ownership/routing and malformed-turn fault isolation.
- `kru chat --provider fake|codex|claude` for arguments, piped input and interactive
  conversations, with per-turn usage and cancellation.
- Minimal, coding and Claude full prompt profiles; stable prefixes, instructions
  under 8,000 bytes and a maximum of six Kru-declared tools. Profile-selected
  native tools are counted independently.
- Reproducible full-versus-coding benchmark with raw usage, generated code and
  independent acceptance results for the first real comparison.
- Shared conformance, permission and liveness tests, opt-in real provider/CLI
  checks, and a nightly latest-Codex schema/tool canary alongside pinned CI.

### Changed

- Normalize usage into inclusive input totals, cache reads, cache writes and
  output, preserving per-turn and cumulative counts without double counting.
- Configure permissions per agent with explicit writable roots. Claude permits
  workspace file tools without an approval UI; outside writes and shell commands
  use host approvals. Enforce path boundaries before native permission rules.
- Use scoped idle timeouts, reset by command output and progress. Explicitly
  executing commands suspend idle detection during silence; native command
  timeouts and cancellation remain available.
- Preserve explicit RPC response errors and apply graceful/forced signal shutdown
  to the common provider lifecycle.

## [0.0.2] - 2026-11-02

### Fixed

- Accept Codex-style envelopes without a `jsonrpc` field, reject explicitly wrong
  versions, and configure all outgoing frames with `jsonrpcField` (default `true`).
- Give process trees a configurable 3-second shutdown grace and trailing stderr
  a configurable 500-ms timeout; retain shorter values in tests.
- Stop every registered connection on SIGINT/SIGTERM, retaining handlers until
  cleanup finishes, and return conventional signal exit codes from the CLI.
- Persist per-child PID/process-group ownership records with start identity for
  future M7 recovery, removing them after completed tree cleanup.
- Handle the transient macOS process-group permission error during child reaping.
- Escalate a second signal to immediate SIGKILL across all tracked process groups,
  bypass remaining shutdown waits, reap children, and exit the host.
- Publish ownership files with a fsynced temporary file and atomic rename.

### Added

- Compatibility, graceful-stop, process ownership, and signal lifecycle tests.
- Ten repeated suite runs in Linux CI and manual workflow dispatch support.
- Ownership record reader that ignores unpublished writes, truncated JSON, and
  invalid schemas without treating them as recovery candidates.
- Codex connection factory that explicitly sets `jsonrpcField: false`, plus an
  exact-byte initialize smoke test against real Codex 0.165.0 locally and in CI.

## [0.0.1] - 2026-11-02

First release: M0 — JSON-RPC over stdio.

### Added

- Generic JSON-RPC 2.0 connection with byte-based framing, strict UTF-8 decoding,
  line limits, concurrent requests, notifications, and inbound request handlers.
- Request timeouts, cancellation, result decoding, bounded stdin writes,
  late-response diagnostics, and process-tree cleanup.
- Deterministic fake agent and the `kru rpc ping --fake` demo, including stall mode.
- `kru --version` and `kru -v`, using the package version.
- Bun/TypeScript project setup, 32 tests, GitHub Actions CI, and M0 documentation.

[0.0.1]: https://github.com/aminhaiqal/kru/tree/v0.0.1
[0.0.2]: https://github.com/aminhaiqal/kru/compare/v0.0.1...v0.0.2
[0.0.3]: https://github.com/aminhaiqal/kru/compare/v0.0.2...v0.0.3
