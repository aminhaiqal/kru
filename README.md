# Kru

Kru is a headless, local-first engine for running AI agent CLIs as persistent
teammates. **M0 is implemented:** a generic JSON-RPC 2.0 transport over stdio,
a deterministic fake agent, and a CLI ping demo.

Providers, persistence, mailboxes, and scheduling come in later milestones.
The roadmap is in [the project plan](docs/Kru%20-%20Project%20Plan%20%26%20Milestones.pdf).

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

See [M0 implementation notes](docs/m0.md) for lifecycle behavior and test coverage.

## Versioning

The current release is **0.0.1**, tagged `v0.0.1`. `package.json` is the source
of the version printed by `kru --version` (or `bun run dev -- --version`).
Each release records its changes in [CHANGELOG.md](CHANGELOG.md) and receives
an annotated Git tag matching the package version.

M0–M4 use `0.0.x` versions. The roadmap reserves `0.1.0` for M5 and `0.2.0`
for M7. Within a release line, fixes increment the patch version.

## Development

```sh
bun test            # all 14 acceptance cases, edge cases, and CLI tests
bun run typecheck  # strict TypeScript
bun run check      # both; also run in CI
```

`src/rpc/` contains only transport logic. The CLI lives in `src/cli/`, and
`test/fakes/fake-agent.ts` provides the scripted protocol peer for this and later
milestones. The runtime has no third-party dependencies.

Kru is inspired by OpenBot and is independently implemented. It contains no
copied OpenBot code. Licensed under [MIT](LICENSE).
