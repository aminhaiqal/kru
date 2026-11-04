# Follow-up verification — 2026-11-04

Checked against `main` at `cc6cfc6d699078123a42f3eb661fa420e3ed70e8`.
Five items can be checked. Strict native action/permission parity remains open.
[Machine-readable evidence](verification/follow-ups-2026-11-04.json).

- [x] **Normalize usage across providers.** `token-usage.ts` adds Claude's separate
  cache counters to its uncached input, and retains Codex's inclusive input total.
  CLI output prints `inputTotal`, `cachedRead`, `cacheWrite` and `output`.
  Shared conformance checks `inputTotal >= cachedRead + cacheWrite` for last-turn
  and cumulative usage on fake, Codex and Claude adapters; invalid counts are rejected.
- [x] **Separate tool budgets.** `prepareThread` caps Kru declarations at six.
  Claude profile-selected built-ins have a separate count and are not capped by
  that budget. Tests retain six coding built-ins alongside six Kru tools and
  verify full-profile native tool reporting. Codex-owned native tools are not
  counted as Kru declarations; their native count is unavailable, rather than zero.
- [x] **Full profile and paired comparison.** Full uses `claude_code` prompt/tool
  presets, project/local settings and native context attachments. The recorded
  full-versus-coding task has usage, generated implementations and unchanged
  acceptance tests. Both archived implementations were independently replayed
  today and passed all 26 acceptance tests. No new benchmark model run was needed.
- [ ] **Strict permission parity on every adapter.** Shared scripted conformance
  passes, and both real CLIs allow file writes under cwd and an explicit extra
  root while refusing an unlisted outside path. However, a separate native shell
  probe with identical `workspace-write` / `never` settings differs: Claude refuses
  Bash; Codex executes a command inside its sandbox without requesting approval.
  The existing scripted Codex peer cannot prove parity for native tools that do
  not make an approval request. File/root parity is verified; full action parity is not.
- [x] **Output/progress resets idle deadlines.** Both real adapter implementations
  pass scripted native event tests for output and progress across multiple idle
  windows. Quiet command boundaries suspend the model-idle watchdog; completion
  resumes it, and cancellation still works. These are adapter/protocol regressions,
  not a new live long-running model/shell experiment.
- [x] **Canary on default branch.** The workflow is already on remote `main` and
  is active, scheduled daily at 03:17 UTC (11:17 Malaysia time). There is nothing
  left to merge. A manually dispatched run on main passed with latest Codex
  `0.166.0`: [run 41780689738](https://github.com/aminhaiqal/kru/actions/runs/41780689738).
  No schedule-triggered run was present in the inspected history; the manual run
  proves execution works, not that cron has fired.

## Checks performed

- `bun run check`: strict TypeScript passed; **125 tests passed, 9 opt-in tests
  skipped, zero failures**. This includes usage, budgets, profiles, shared
  permission decisions and both adapters' output/progress liveness cases.
- `KRU_TEST_PERMISSIONS=1 bun test test/permissions-live.test.ts`: **2 live tests
  passed**, verifying real workspace/root writes and refusal of outside writes.
- Archived full/coding implementations rerun with the original `task.json`
  acceptance source in separate temporary workspaces: **26/26 each**.
- Separate live native shell probe: both received the same marker-writing shell
  request and `workspace-write` / `never`; no host approval was granted. Claude
  left the marker absent, Codex created it. Exact observations and the prompt
  template are retained in the JSON evidence.
- GitHub confirmed `main` as default, the canary file on main, workflow state
  `active`, and the successful manual run. Existing main CI is also green:
  [run 41587315620](https://github.com/aminhaiqal/kru/actions/runs/41587315620).

## Existing paired benchmark

| Measurement | full | coding |
| --- | ---: | ---: |
| Input total | 161,579 | 98,257 |
| Cached read | 147,055 | 66,954 |
| Cache write | 14,515 | 31,295 |
| Output | 8,697 | 13,896 |
| Independent acceptance | 26/26 | 26/26 |

These are the recorded November 3 counters, not a second model run. Reads and
writes are included in input totals. This one pair demonstrates the requested
task comparison; it does not establish general cost or quality parity.

See the [benchmark evidence](benchmarks/claude-profiles-2026-11-03/README.md).

## Closing strict native permission parity

The native approval flags alone cannot establish the intended common contract.
The live shell probe above demonstrates that `never` suppresses native Codex
approval requests without forbidding sandboxed shell execution. Claude's tool
hook instead denies shell execution under that policy.

Codex's [official hooks documentation](https://learn.chatgpt.com/docs/hooks#pretooluse)
also rules out a simple hook-only claim of strict parity: `PreToolUse` supports
denials, but `permissionDecision: "ask"` is currently unsupported and causes the
hook to fail while the tool call continues. The documented tool coverage also
has exceptions and explicitly is not a complete enforcement boundary.

A strict mode should route file/shell operations through Kru-controlled tools
and one shared approval policy, disable alternate native execution paths, and
reject strict-mode startup when a provider cannot enforce that boundary. It
must prove in live tests that in-root file operations are allowed, outside-root
operations and shell commands ask under `on-request`, and those operations do
not execute after refusal, under `never`, or when no approval handler exists.
Native full-profile tool behavior would remain a distinct compatibility mode.
This is a design requirement, not an implemented strict-mode guarantee.

## Reproduce the native shell gap

```sh
bun run test:permissions-live
bun run test:shell-parity-live
```

Both commands make real model calls through the existing provider logins. The
first verifies file/root writes. The second uses two fresh temporary workspaces,
the same coding profile and `workspace-write` / `never` settings, grants no host
approvals, and asks each provider to create a harmless marker using its shell.
It checks actual file creation and tool events, rather than relying on the reply.
Temporary workspaces are removed afterwards.

The shell probe exits `1` when either adapter executes or asks for approval under
`never`, `2` when the run is inconclusive (including an auth error, no shell
attempt or an alternative file tool), and `0` when both deny this specific case.
The current expected observation is Claude without a marker and Codex with one:
exit `1`. Even a successful shell-only probe does not replace the full strict
permission matrix described above.
