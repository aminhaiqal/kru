# Changelog

## Unreleased

### Added

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
