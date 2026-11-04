# v0.2 release audit

Checked on 2026-11-05 against the expanded
[project plan](Kru_Project_Plan_and_Milestones.pdf), M7 and the shared release
checklist. This distinguishes a verified engine milestone from a public npm
announcement. The source package/tag remains v0.1.1 pending the next release
instruction; M7 changes are recorded under Unreleased.

**Expanded M6 follow-up:** the [original audit](m6-conformance-review.md) gaps
are resolved. [M6 notes](m6.md) map the implementation to all eighteen PDF cases;
[current verification](verification/m6-expanded-2026-11-05.json) records the
repeated M6/M7 regressions and demos. Public packaging/announcement tasks below
remain separate release work.

## Engineering checks

- M7's 24 deterministic acceptance cases pass ten repetitions on macOS arm64
  and Linux arm64, including real SIGKILL/restart and owned orphan-child cleanup.
- Strict TypeScript and the complete M0–M7 suite pass on both platforms.
- Expanded release repetitions cover retention/redaction, messaging, native
  adapter routing, M6 threads and M7 crash recovery.
- The real crash demo reports an interrupted attempt, quarantined generation,
  explicit usage gap, contained child, completed queued successor and replay parity.
- Frozen v7 upgrade and injected v8 migration failure roll back/retry; shipped
  migrations/payloads remain unchanged. The subsequent M6 v9 upgrade uses a
  frozen v8 fixture and brings replay verification to twenty-two projections.
- `git diff --check` passes. CI now includes Ubuntu and macOS with the complete
  suite repeated ten times. Local Docker verification is recorded separately
  from remote CI, which has not run for uncommitted changes.

Exact commands, counts and platform evidence are in
[the original M7 verification](verification/m7-2026-11-05.json) and
[current M6 follow-up](verification/m6-expanded-2026-11-05.json).
The repeatable local gate is `bun run check:release`.

## Shared announcement checklist

| Item | Result |
| --- | --- |
| MIT license and independent OpenBot inspiration note | Present in LICENSE and README |
| Credential-free quick start | Existing fake CLI quick start; messaging, handoff and crash demos |
| Runnable coder/reviewer example | `bun examples/coder-reviewer.ts` |
| Lifecycle architecture diagram | [architecture.md](architecture.md) |
| CI against scripted providers | Ubuntu/macOS matrix; no model credentials needed |
| Permissions and recovery limits | [SECURITY.md](../SECURITY.md) and [M7](m7.md) |
| Common stored credential redaction | Covered by release tests; arbitrary messages/tool output/raw diagnostics remain reviewable sensitive data |
| Changelog and semantic versioning | Unreleased M7/expanded M6 entries prepared; v0.2.0 bump and annotated tag are a release action still pending |
| Milestone implementation write-up | [M7 notes](m7.md), prior milestone notes retained |
| GitHub project name | Existing `aminhaiqal/kru` repository |
| npm name | `npm view kru name version description --json` returns an existing package, version `0.0.1-security.2`; plain `kru` is occupied |
| One-line public install | Pending: package is `private: true`, is not published, and requires a publishable name/build/install smoke test |
| README 30-second demo GIF | Pending; deterministic runnable demos are available |
| Slack bot and nightly routine examples | Deferred with their post-M7 API/routine features |

Before a public npm announcement, choose/obtain a package namespace, define a
publication file allowlist and verify installation from the packed artifact in
a clean directory with Bun. Then supply the demo recording and carry out version
bump/tag/publish. This audit does not reserve a package name, publish a package
or create a GitHub release.

## Recovery release limits

The verified platforms are Linux and macOS; Windows containment is unsupported.
A boot with unverifiable ownership, unrecorded descendants or inconsistent state
blocks execution. File/remote effects are not rolled back or made exactly-once.
Only committed checkpoints survive; partial/missing usage is not final cost.
The operator must inspect effects before retrying, and a usage bound cannot
bypass process containment. Live model quality and production account billing
are outside these scripted release checks.
