# Skills workflow builder

Skills now opens a visual workflow library and editor. A workflow is an editable
graph; each execution gets a frozen copy of that graph and its own node state.
Existing prompt-based bot skills import once as Trigger → Bot task workflows.
The original bot skill records remain available to the `workspace` agent tool.
Editing an imported workflow does not rewrite its original prompt asset.

## n8n source reference

The architecture was studied at n8n commit
`cd6e8cc5fcdf7bc4d16f7ea6f56c2f819fe7f976`:

- [Workflow graph model](https://github.com/n8n-io/n8n/blob/cd6e8cc5fcdf7bc4d16f7ea6f56c2f819fe7f976/packages/workflow/src/workflow.ts)
  separates nodes, parameters, directed connections and workflow activation.
- [Execution engine](https://github.com/n8n-io/n8n/blob/cd6e8cc5fcdf7bc4d16f7ea6f56c2f819fe7f976/packages/core/src/execution-engine/workflow-execute.ts)
  routes node output to connected inputs and maintains execution state, results,
  errors, cancellation and waiting state independently from the editor.

KRU applies those basic concepts with an independent implementation. Its SVG
canvas uses the existing plain JavaScript frontend and Tailwind styling. Its
executor runs in the existing Bun daemon and stores event-backed SQLite state.
No n8n runtime, node code or frontend code is embedded or copied.

## Nodes and data

| Node | Behavior |
| --- | --- |
| Trigger | Accept manual JSON input, or start on an activated interval |
| Bot task | Use the existing bounded task runner; return `result` and checked `steps` |
| App tool | Call a tool on an existing Plugin owned by the workflow bot |
| Edit data | Build fields from literals or mapped values; merge or replace input |
| Condition | Route input to true/false outputs using a typed comparison |

The first version supports up to 30 nodes and 60 connections, with one incoming
connection per node. A connected, acyclic graph and exactly one trigger are
required to run. Fan-out and conditional branches are supported; node execution
is sequential. There are no loops, merge nodes or arbitrary code evaluation.
Drafts may contain unconfigured or disconnected nodes until they are ready to run.

Data mapping uses property paths rather than JavaScript evaluation:

```json
{
  "message": "{{input.message}}",
  "summary": "{{steps.agent.result}}"
}
```

`input` is the selected parent output. `steps.<nodeId>` reads an already completed
node's output; the editor displays each node's stable ID. A whole expression
preserves the source JSON type. An expression inside a string interpolates text.
Missing paths fail the node, and prototype-related paths are rejected.

App output includes the original MCP result and `data`: structured content when
provided, otherwise parsed JSON from text content, or plain text. Inspect the
Input/Output tabs or execution history to find the right path for the next step.
Each node's stored input/output is limited to 64 KB. Bot input has an additional
11 KB limit so its task prompt remains inside the existing runner budget.

## Existing connectors and conversations

App tool nodes reference Plugin IDs; credentials remain in the existing
connector/environment mechanism. The editor loads the actual MCP tool list and
shows its input schema. Disabled or foreign-bot connectors cannot run.

An Ask connection creates an exact-step approval record and pauses the run.
The reminder opens `workflow:<runId>` in the owning bot's conversation. Accepting
authorizes only that step and its frozen arguments. The executor rechecks the
connector configuration before calling it; changed configuration requires fresh
consent on explicit resume. Allow connections use their existing permission grant.

Bot task nodes may use the default workflow bot or another selected bot. They use
the same provider connections, permissions, memory, budget, task completion and
native approval behavior as other KRU work. Workflow tasks stay in their workflow
history rather than being duplicated as General project Work items.
The workspace shares one TaskRunner with Work and workflows. TaskRunner owns
delivery-state and pending-cancellation checks; workflows own graph progression
and require both explicit task completion and successfully settled deliveries
before completing a bot step. See [execution ownership](WORK_ARCHITECTURE.md#execution-ownership).

## Persistence and recovery

Migration 12 adds `workflow_definitions`, `workflow_runs` and
`workflow_node_runs`, bringing deterministic replay to 30 projections. Definition
updates use revisions. Run starts use idempotency keys, and the editor never
changes an existing run's frozen graph.

Pure data steps commit synchronously. App steps persist their running state
before making an external call. Cancellation aborts active calls, stops bot tasks,
expires pending requests and prevents late responses from advancing the run.
After restart, unfinished runs become Interrupted and never silently retry an
uncertain action. Explicit Resume continues from stopped steps after the operator
checks effects; completed and skipped steps are retained. A stopped bot task that
cannot be safely resumed requires a new run. External services do not gain an
exactly-once guarantee from local persistence.

Activating an interval schedule is explicit. A busy workflow coalesces missed
intervals instead of building an overlapping queue. Failed scheduled starts are
recorded in execution history. The host and daemon must remain running.

## Code map

- `src/workflows/types.ts`: graph validation, node types and data rows.
- `src/workflows/data.ts`: bounded JSON data and property-path mapping.
- `src/workflows/service.ts`: definitions, imports, execution, schedules and recovery.
- `src/web/client/workflows.js`: graph canvas, node inspector and run history.
- `src/web/styles/workflows.css`: workflow UI styling.
- `test/workflows.test.ts`: graph/data, connector, approval, recovery and API tests.
- `scripts/check-workspace-ui.ts`: real Chromium workflows using scripted bots
  and a local MCP fixture; no real model calls or third-party account changes.
