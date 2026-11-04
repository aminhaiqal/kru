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

Slack-over-HTTP and nightly routine examples depend on the API/routine features
on the roadmap after M7 and are not implemented yet.
