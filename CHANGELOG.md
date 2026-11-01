# Changelog

## Unreleased

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

### Added

- Compatibility, graceful-stop, process ownership, and signal lifecycle tests.
- Ten repeated suite runs in Linux CI and manual workflow dispatch support.

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
