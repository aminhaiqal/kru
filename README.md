# Kru

Kru is a headless, local-first engine for running AI agent CLIs as persistent
teammates. **M0–M3 are implemented:** a generic JSON-RPC transport, a typed
provider port with fake, Codex and Claude adapters, streaming terminal chat,
a durable SQLite mailbox, and a daemon with lane scheduling and batching.
The roadmap is in [the project plan](docs/Kru%20%E2%80%94%20Project%20Plan%20%26%20Milestones.pdf).

## Try M0

Install [Bun](https://bun.com/docs/installation) 1.3 or newer, then:

```sh
bun install
bun run dev -- rpc ping --fake
# pong (… ms)

bun run dev -- rpc ping --fake --stall
# error: request "ping" timed out after 2000 ms

bun run check
```

No model, network connection, or API key is needed after dependency installation.
For the literal `kru` command, run `bun link` once in this checkout. You can also
run `bun src/cli/index.ts rpc ping --fake` directly. This package is not published.

## Try M1

```sh
bun run dev -- chat --provider fake "hello"
# Echo: hello

bun run dev -- chat --provider codex "hello"
bun run dev -- chat --provider claude "hello"
# A streamed reply from your installed Codex CLI

printf 'hello' | bun run dev -- chat --provider fake
bun run dev -- chat --provider codex
# Interactive chat in one thread; /quit or /exit finishes
```

Fake chat needs no credentials. Codex and Claude use the corresponding provider's
existing login and model configuration. `--model <name>` overrides the model.
`--idle-timeout-ms <ms>` sets the inactivity deadline (default 120 seconds);
progress resets it. `--timeout-ms` is an alias. Usage prints to stderr each turn,
including inclusive input totals, cache reads, cache writes and output. Cache
counts are subsets of input, so they are never added to it twice.

Agent configuration includes `promptProfile` (`minimal`, `coding` or Claude's `full`), sandbox
(`read-only` or `workspace-write`) and approval policy (`on-request` or `never`).
Defaults are minimal, read-only and on-request. Hosts answer typed approval
requests; the CLI prompts for command and file approvals when stdin and stderr
are terminals. Enter `y` or `yes` to approve once; all other answers decline.
Piped/non-terminal runs and `--approval-policy never` decline requests.
Kru instructions must
be under 8,000 bytes and there may be at most six Kru-declared tools. Claude's
profile selects built-ins independently and reports their count separately in
thread prompt metadata; they do not consume the Kru tool budget. Provider-owned
context and native Codex tools are not included in that measurement.

`workspace-write` permits Claude file tools inside `cwd` and extra roots supplied
with repeatable `--writable-root <path>` flags, without a host approval listener.
Outside writes and shell commands need approval. For an interactive Claude shell
approval, run:

```sh
bun run dev -- chat --provider claude --prompt-profile coding --sandbox workspace-write --approval-policy on-request "Run echo hello using Bash"
```

The CLI shows the requested action before asking `Allow this action? [y/N]` on
stderr. Approval is per action, not a session-wide grant. EOF declines; cancellation
or the provider's request deadline closes input so late consent cannot approve
another request. Structured permission grants, elicitation and tool input requests
still require an embedding host and are declined by the CLI.

Codex receives the same roots in its native sandbox. Implicit temporary-directory
write grants are disabled; add a temporary root explicitly if required. Idle
timeouts pause during explicitly running native commands, even without output,
and resume after command completion. Cancellation remains available.
Codex can execute native commands inside its sandbox without asking, while Claude
asks the host for shell access. This prompt does not establish strict native shell
permission parity between the providers.

To exercise Codex's approval prompt with a harmless command, explicitly request
approval for running outside its sandbox:

```sh
bun run dev -- chat --provider codex --prompt-profile coding --sandbox workspace-write --approval-policy on-request 'Run echo hello once using the shell executor with sandbox_permissions="require_escalated" and justification="May I run echo hello?". If denied, stop without retrying.'
```

This exercises a native approval request; the prompt instruction does not enforce
approval for every Codex command. Ordinary sandboxed commands can run automatically.
See [OpenAI's sandbox and approvals documentation](https://learn.chatgpt.com/docs/agent-approvals-security#sandbox-and-approvals).

Claude's `full` profile uses the native Claude Code prompt and standard tools,
loads project/local settings and CLAUDE.md, and retains native context attachments.
It supplies the baseline for measuring the custom `coding` profile. Run
`bun run benchmark:claude-profiles --plan` to preview five counterbalanced blocks
on legacy Sonnet 4.6 and current Sonnet 5.5. Add `--run` to execute the controlled
prompt/tool variants with a recorded warm-up and median/range reports (uses the
existing Claude login/quota). See the [benchmark protocol](docs/benchmarks/profile-factorial-protocol.md).
The [2026-11-04 results](docs/benchmarks/claude-profiles-2026-11-04/README.md)
contain 38 passing measured runs and two quota failures. Coding reduced input on
both models; estimated cost increased on Sonnet 4.6 and decreased on the four
completed Sonnet 5.5 pairs. Coding remains opt-in.

All three adapters use the same chat consumer and conformance suite, including
explicit prefix-stability and context-budget tests. Default Codex views share one
process and isolate thread events. Claude uses the official Agent SDK, a streaming
input queue and in-process MCP tools. See [M1 implementation notes](docs/m1.md)
for configuration, permissions, idle deadlines and failure isolation.

## Try M2

```sh
bun run dev -- init
bun run dev -- agent create reviewer --provider fake
bun run dev -- send reviewer "review the latest commit" --idempotency-key review-1
bun run dev -- queue reviewer
# <delivery-id> queued user "review the latest commit"
bun run dev -- cancel <delivery-id>
bun run dev -- retry <delivery-id>
```

Run `init` once at the project root. Commands search upward for `.kru/`, so
subfolders use the same `.kru/kru.sqlite` mailbox. Outside a project, commands
ask you to initialize one. Use `--db <path>` or `KRU_DB` to override discovery. Repeating the same idempotency key returns
the first receipt; using it with different content is refused.
`send reviewer,coder "review this"` creates one message with independent deliveries.

M2 stores work and enforces delivery transitions. The M3 daemon runs queued work.
`chat` remains the direct M1 chat command.
See [M2 implementation notes](docs/m2.md) for the mailbox port, state machine,
migrations, CLI options and acceptance coverage.

## Try M3

```sh
bun run dev -- daemon
# Leave running; in another terminal in the same project:
bun run dev -- send reviewer "review the latest commit"
bun run dev -- status
bun run dev -- status --json

bun run dev -- agent pause reviewer
bun run dev -- agent set reviewer --daily-tokens 200000
bun run dev -- agent resume reviewer
```

Use the fake agent created above to try scheduling without credentials. The
single daemon watches committed work from other terminals, runs up to two turns
at once, and batches consecutive user messages in each lane. `status` explains
paused, provider readiness, lane, budget and slot holds. Budget days use local
time by default; `daemon --budget-timezone Asia/Kuala_Lumpur` sets an explicit
zone. Daemon counters and estimated token costs now persist in the [usage ledger](docs/usage-and-pricing.md). Every turn has a delivery behind it; uncertain turns become
interrupted and require an explicit retry. Stop the daemon with Ctrl+C.

See [M3 implementation notes](docs/m3.md) for session bindings, atomic batches,
shutdown, crash recovery, command options and acceptance tests.

## Cost and dollar budgets

```sh
bun run dev -- agent set coder --model claude-sonnet-5-5 --prompt-profile full
bun run dev -- agent set coder --daily-tokens 200000 --daily-usd 2.00
bun run dev -- cost
bun run dev -- cost --agent coder --json
```

Both limits apply and survive daemon restarts. Costs are estimated main-agent
token costs at dated list prices, with separate cache-read and write-lifetime
rates. Missing lifetimes produce a range; the dollar gate uses its upper bound.
Unknown/unpriced usage is held rather than assumed free. These are not hard caps
on all account charges. See [pricing and ledger scope](docs/usage-and-pricing.md).

## Transport API

```ts
import { RpcConnection } from "./src/rpc";

const rpc = new RpcConnection({
  command: process.execPath,
  args: ["test/fakes/fake-agent.ts"],
  requestTimeoutMs: 2_000,
  maxLineBytes: 256 * 1024 * 1024,
  maxQueuedWriteBytes: 4 * 1024 * 1024,
  maxBadLines: 3,
  jsonrpcField: true,          // false for Codex's headerless wire format
  stopGraceMs: 3_000,
  stderrDrainTimeoutMs: 500,
  processRecordDir: ".kru/processes",
});

rpc.on("diagnostic", (diagnostic) => console.error(diagnostic));
rpc.on("notification", ({ method, params }) => { /* consume events */ });
rpc.on("exit", (error) => { /* inspect exitCode, signal, lastStderrLine */ });
rpc.onRequest(async ({ method, params, signal }) => {
  // Return the result; honor signal if the operation can outlive the process.
  return { accepted: true };
});

rpc.start();
try {
  const answer = await rpc.request("ping", {}, {
    timeoutMs: 2_000,
    decode(value) {
      if (value !== "pong") throw new Error("Expected pong");
      return value;
    },
  });
  console.log(answer);
} finally {
  await rpc.stop();
}
```

`request` accepts an optional `AbortSignal`. `notify(method, params?)` waits for
the frame to be written. `env` overrides entries in the inherited environment.
`start()` spawns a child; a connection can restart after `stop()` resolves or
its `exit` event fires. There are no automatic restarts or retries.

Incoming messages accept an omitted `jsonrpc` field, or the value `"2.0"`.
`jsonrpcField` controls all outgoing requests, notifications, results, and errors;
it defaults to `true`. Set it to `false` for Codex app-server, whose
[wire protocol omits the field](https://learn.chatgpt.com/docs/app-server).

Shutdown gives the process tree 3 seconds before SIGKILL, then allows up to 500 ms
for trailing stderr. Both timeouts are configurable. Tests use a 100-ms shutdown
grace and a 50-ms stderr timeout.

The CLI handles SIGINT and SIGTERM and stops its connections. Embedders can opt in
with `installRpcSignalHandlers(connections)` from `src/rpc`; keep the returned
handle until shutdown finishes, use its `exitCode`, and call `dispose()` afterwards.
Pass an array or a live `Set` containing every active connection.
The first signal stops gracefully. A second signal calls `forceStop()` on every
tracked connection, sends SIGKILL to all process groups without waiting between
them, skips the remaining shutdown waits, and exits the host after reaping children.

Each child has a private ownership file in `.kru/processes` by default. It records
the owner PID, child PID, process group, timestamp, and available OS start identity.
The writer fsyncs a private temporary file, closes it, then atomically renames it
to its final `.json` path. `readProcessRecords()` ignores temporary files,
truncated JSON, and invalid records; it only returns recovery candidates.
Normal cleanup removes the record; SIGKILL leaves it for M7 boot recovery.
Recording does not yet implement orphan recovery. See the notes below for details.

See [M0 implementation notes](docs/m0.md) for lifecycle behavior and test coverage.

## Versioning

The current release is **0.0.5**, tagged `v0.0.5`. `package.json` is the source
of the version printed by `kru --version` (or `bun run dev -- --version`).
Each release records its changes in [CHANGELOG.md](CHANGELOG.md) and receives
an annotated Git tag matching the package version.

M0–M4 use `0.0.x` versions. The roadmap reserves `0.1.0` for M5 and `0.2.0`
for M7. Within a release line, fixes increment the patch version.

## Development

```sh
bun test            # transport, provider conformance, runtime and CLI tests
bun run typecheck  # strict TypeScript
bun run check      # both; also run in CI
bun run test:mailbox # M2 store, mailbox acceptance and CLI tests
bun run test:mailbox:repeat # repeat every M2 test ten times
bun run test:scheduler # M3 scheduler, batch, daemon CLI and migration tests
bun run test:scheduler:repeat # repeat every M3 test ten times
bun run test:codex # optional: real initialize + tool registration, no model call
bun run test:providers # fake, Codex and Claude conformance; no model or credentials
bun run test:codex-chat # opt-in: real Codex model turns
bun run test:claude-chat # opt-in: real Claude queue, MCP tool, usage and resume
```

`src/rpc/` contains only transport logic. The CLI lives in `src/cli/`, and
`test/fakes/fake-agent.ts` provides the scripted protocol peer for this and later
milestones. The transport has no third-party dependencies; Claude uses the official
Agent SDK and Zod.

`src/providers/codex/transport.ts` is the Codex adapter's connection factory: it always sets
`jsonrpcField: false`. The real-Codex smoke test uses that factory through a
transparent stdio recorder and compares the exact request and notification bytes.
CI runs it separately with Codex 0.165.0. The regular suite uses scripted peers and
SDK/MCP fixtures without model credentials.

A separate [nightly canary](.github/workflows/codex-canary.yml) tests latest Codex
initialize bytes, experimental tool registration and generated protocol schemas.
Stable CI stays pinned; the canary needs no model credential.

Kru is inspired by OpenBot and is independently implemented. It contains no
copied OpenBot code. Licensed under [MIT](LICENSE).
