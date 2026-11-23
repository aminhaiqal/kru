# Examples

```sh
bun examples/coder-reviewer.ts
bun run demo:handoff
bun run demo:recovery
```

All three examples use scripted providers and temporary databases; no model
login or network call is required after installing dependencies. The first
demonstrates asynchronous teammate requests/replies; the second demonstrates
durable history across a provider switch; the third kills a real daemon and
verifies owned-child cleanup before queued work continues.

Run `bun run ui` for the local workspace, HTTP API, daily/interval/webhook
routines, and per-agent MCP connections. See [the workspace guide](../docs/WORKSPACE.md).
Service-specific Slack adapters are supplied through compatible MCP servers.
