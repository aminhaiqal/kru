# Work architecture

Work is KRU's project and workflow layer. It replaces the Tasks page while
retaining the existing task runner, durable mailbox, scheduler and provider
adapters. A work item describes an outcome; a run executes one workflow stage.
Keeping these separate allows human work, reassignment, multiple agent stages
and review without losing execution history.

## Multica reference

The implementation was informed by the supplied Multica screenshot and source at
commit `fa71dc9861ee9437cc7ca2504f9f064337b77675`:

- [Repository and architecture overview](https://github.com/multica-ai/multica/tree/fa71dc9861ee9437cc7ca2504f9f064337b77675):
  Next.js frontend, Go backend, PostgreSQL and local agent daemon.
- [Workflow types](https://github.com/multica-ai/multica/blob/fa71dc9861ee9437cc7ca2504f9f064337b77675/packages/core/types/issue-workflow.ts):
  ordered stages with handlers, instructions and forward/backward transitions.
- [Workflow entry handling](https://github.com/multica-ai/multica/blob/fa71dc9861ee9437cc7ca2504f9f064337b77675/server/internal/handler/issue_workflow_entry.go):
  stage entry resolves assignment and can enqueue an agent run.

KRU adopts the separation of issues, workflow stages and agent runs, plus the
project sidebar / board / detail-panel interaction. The code and styles are
implemented independently in KRU's existing Bun application. KRU keeps SQLite,
its existing provider runtimes and a single local UI/daemon process. This is a
focused Work implementation, not a port of Multica's full platform.

## Data and execution

Migration 11 adds four event-backed projections:

| Projection | Responsibility |
| --- | --- |
| `work_projects` | Stable identifier prefix, project context and ordered stages |
| `work_items` | Brief, properties, current stage, assignee and revision |
| `work_runs` | Link from a stage execution to an existing task record |
| `work_activity` | Durable edits, transitions, comments and agent results |

All changes use Store transactions and versioned events. Replay rebuilds these
alongside the existing projections, for 27 tables in total.

1. A work item starts in Brief. It may remain unassigned and need no model call.
2. Stage entry resolves the stage agent, unless the operator explicitly supplied
   an assignee. Without a stage agent, the current assignee remains in place.
3. An assigned active stage creates a TaskRunner record and its `task:<id>`
   delivery atomically with the work/run link and activity.
4. The existing scheduler runs the user's connected provider. Its normal tool,
   approval, budget, permission and recovery rules apply.
5. TaskRunner requires explicit completion, checked steps and a result. Work
   settles a run only after its deliveries are terminal.
6. If that run still belongs to the item's current stage, Work advances to the
   next stage and starts its agent. The bounded prompt includes stage instructions,
   the original brief, project context, previous result and recent comments.
7. Review stops automatic execution. The operator approves Done or requests
   changes. No agent stage automatically marks the work item Done.

## Consistency and recovery

Work item updates require a matching revision. Moving stages or reassigning
cancels pending execution, then interrupts the previous native lane after the
database transaction commits. A late result remains in history but cannot advance
an item that has moved elsewhere. Done rejects outstanding historical executions.

Blocked or uncertain runs never automatically retry. Explicit Resume includes
recent operator comments. Archive cancels pending work; restore does not restart
it. Comments use command receipts for idempotency. Existing tasks import once
with their original task IDs, lanes, progress and results.

The UI derives Working and Queued from mailbox state. A disconnected provider or
paused teammate is shown as such. Completion is an agent assertion with evidence;
the human review gate owns the final decision.

## Code map

- `src/work/types.ts`: workflow and work-input validation.
- `src/work/service.ts`: transactions, assignment, handoffs, imports and activity.
- `src/workspace/runtime.ts`: service integration and lifecycle ticks.
- `src/web/server.ts`: authenticated Work routes.
- `src/web/client/work.js` and `src/web/styles/work.css`: board, list, editors and detail panel.
- `test/work.test.ts`: handoffs, stale executions, review, replay and API checks.
- `scripts/check-workspace-ui.ts`: real Chromium interaction checks using
  scripted providers in an isolated database.
