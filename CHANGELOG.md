# Changelog

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
