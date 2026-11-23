# Local agent workspace

Run `bun install` and `bun run ui`, then open <http://127.0.0.1:4310>.
The UI, API, daemon and routine runner share one process and one SQLite database.
`kru serve` is an alias for `kru ui`. Both accept `--port` and `--db`.
An existing daemon must stop before the UI can own that same database. Multiple
projects can use separate databases and ports. No cloud account or hosted frontend
is required. Work runs while the host and command remain running.

## Teammates and conversations

### Connect Codex and Claude Code

Open **AI connections**. KRU checks `codex login status` and
`claude auth status --json` on this computer. The page starts in Checking and
distinguishes Not installed, Not connected, Connected, and Needs attention.
Executable presence or an imported SDK alone never produces Connected. A status
check confirms the local CLI reports authentication; it does not make a paid
model request or guarantee quota, network access or model entitlement.

Use **Install** when a CLI is missing. KRU runs npm against the official
`@openai/codex` or `@anthropic-ai/claude-code` package in a project-private
`providers/<database-id>/<provider>` directory beside the database. Existing
global installations are not overwritten. Node.js with npm is required for this
installation path. Update CLI uses the same private installation when the
existing CLI cannot report its authentication state.

Use **Sign in** for an installed provider. Codex starts its native device flow
and displays the provider's verification link and one-time code. Claude Code
starts `claude auth login`, opens its normal browser sign-in, and exposes an
official sign-in link when the CLI prints one. If Claude asks for a returned code,
**Enter a sign-in code** forwards it directly to that running CLI. Setup can be
cancelled and expires after ten minutes (five minutes for installation).

Completing setup triggers another status check. **Recheck** also picks up sign-in
or sign-out performed in another terminal; checks refresh every thirty seconds
while the UI runs. Disconnected providers hold queued work, and the conversation
composer links to the connection page. Reconnecting refreshes idle provider
runtimes so newly installed executables and credentials are used. Existing active
turns finish normally. Demo teammates require no connection.

KRU uses the detected executable, including managed installations, for Codex and
Claude Code execution. `KRU_CODEX_EXECUTABLE` and `KRU_CLAUDE_EXECUTABLE` override
discovery; remove or correct an invalid override before reinstalling. Provider
authentication follows the current process's normal home/config directory and
environment. API-key authentication is labelled separately from saved account
sign-in. KRU does not copy account tokens or persist sign-in codes in SQLite.
Only recognized official sign-in hosts are presented as clickable links.

See the providers' [Codex authentication guide](https://learn.chatgpt.com/docs/auth)
and [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
for the native commands and account options. The browser smoke check simulates
installation and account sign-in; it never changes your real accounts.

Create a teammate in the UI and choose Codex, Claude, or Demo (`fake`). Codex and
Claude use the installed provider's existing authentication. No provider/model
credentials are stored by this UI. Demo exercises the conversation/queue path
without model calls; it echoes messages and does not reason or autonomously
complete tasks.

The coding profile exposes the provider's coding tools. Workspace write access
permits file changes under the configured working directory. Read-only is the
initial UI default. The full profile is available for Claude. Permissions remain
provider-specific as documented in the project README.

Conversations stream through an authenticated event connection. Main chat, work runs
and routines have separate durable lanes, selectable using the Thread menu.
Agent configuration, pausing, budgets and cancellation operate on the existing
registry and scheduler. The activity view reports observed tokens and estimated
main-agent spend; unknown usage and external service charges are not invented.

## Work

Work replaces the Tasks page. Create a project with a stable identifier prefix
and either the standard workflow (Brief → In progress → Review → Done) or the
content workflow (Brief → Research → Writing → Review → Done). Project settings
let you rename stages, add active stages, choose stage agents and supply stage
instructions. Stages containing work cannot be removed.

Write a work item with a brief, priority, assignee, labels, due date and acceptance
criteria. Use the project board or list, search and assignee/priority filters.
Click a card for its properties, activity, comments, results and agent run history.
Drag cards between stages or use the detail panel's Stage selector. Concurrent
edits are rejected using the work item's revision so stale clients cannot overwrite
newer state.

Entering an active stage starts its stage agent; explicitly choosing Unassigned
keeps it human-owned. With no stage agent, the current work item assignee is kept.
Changing the agent or stage cancels the previous pending run and interrupts its
native lane. Agent completion hands evidence to the next active stage, then stops
at Review. **Approve & complete** moves reviewed work to Done; **Request changes**
returns it to the last active stage. An active historical execution prevents Done.
Comments are context for the next stage or explicitly resumed blocked run; they do
not inject messages into a currently running turn. Archive stops pending execution;
restore preserves history without restarting it. Use Resume agent to explicitly
restart restored, cancelled work or a blocked run.

Existing task records become General project work items with the same execution
lanes and history. Completed tasks enter Review, and cancelled tasks are archived.
Import is idempotent and never queues another delivery for an existing task.
See [Work architecture](WORK_ARCHITECTURE.md) for the source research and data flow.

### Bounded agent runs

A task stores its objective, success criteria, steps, result, status and execution
attempts. Assigning it atomically creates a `task:<id>` lane delivery. During that
turn, `task_update` can update only the task owned by the active execution.
Completion requires a nonempty result and every recorded step checked. This is
an explicit agent assertion with evidence, not independent proof of correctness.

After a confirmed successful turn, a still-running task receives another delivery
with its recorded progress. The default limit is eight turns; it can be configured
from 1 to 50. Reaching the limit blocks the task for review. Failed, cancelled or
unknown executions do not automatically retry. Recovery marks uncertain work
interrupted; the task becomes blocked. Resume is an explicit operator action and
adds a bounded allowance, up to 50 total attempts. Inspect side effects before
resuming uncertain work. Cancel stops queued deliveries and interrupts an active
task lane. Pausing a teammate prevents future execution but does not interrupt an
already running turn.

## Approvals

Native command/file approval requests and KRU external tool requests can wait in
the Approvals view. Decisions are bound to the exact execution, native turn and
request; they expire after ten minutes. Idle expiry is suspended while a provider
request awaits its bounded response. Cancellation, provider request expiry and
shutdown decline a waiting request. On restart, old pending approvals expire;
they are never replayed as grants against a replacement process.

Approval records and user decisions are durable. A disconnected UI can reconnect
while the original provider request remains alive. Restarting the daemon cannot
resume a native permission callback. Structured native permission grants,
elicitation forms and question-answer payloads are not authored by this UI;
ordinary Allow once provides only an acceptance decision, not custom response
content. Use a suitable embedding host for those structured provider workflows.

For a daemon running without the UI, use another terminal:

```sh
bun run dev -- approval list --json
bun run dev -- approval accept <approval-id>
bun run dev -- approval decline <approval-id>
```

External MCP connections and browser actions default to asking before actions.
An operator may explicitly select Allow for a connection or browser. Agent tools
cannot modify those grants. An agent with `approvalPolicy=never` receives a tool
error when a KRU external action would need consent. Connector ownership,
configuration and enabled status are rechecked before execution.

## MCP connections and credentials

The Tools view supports local stdio processes and remote Streamable HTTP MCP
servers. Connections belong to one teammate. Discover tools checks the real
server and displays its schemas. Agents discover tools through `workspace` and
call them using `use_tool`; dynamic discovery keeps Kru's six-tool prefix bounded.
MCP server-initiated model sampling and elicitation are not enabled.

Credentials are supplied using environment references. For example, start KRU
with `MY_APP_KEY` set through your normal secret manager, then configure a stdio
mapping `{"API_KEY":"MY_APP_KEY"}`. Only the explicitly mapped secrets and the
MCP SDK's safe base environment reach the child process; it does not inherit all
provider credentials. For HTTP, map a header to an environment variable, e.g.
`{"Authorization":"MY_APP_AUTH"}` where that environment value includes the
complete `Bearer ...` header. Do not paste secrets into executable arguments,
URLs, memory or messages. Environment changes require restarting KRU.

The operator supplies an already authenticated MCP endpoint or credential
references. This release does not include an app marketplace or a general OAuth
account-linking flow. GitHub, Slack, Gmail and other services can be connected
through compatible MCP servers; no service-specific connection is fabricated.

Local MCP subprocesses use Kru's RPC process ownership records, cleanup journal
and boot containment. Tool requests honor cancellation and timeouts. Uncertain
remote effects remain uncertain; neither receipt deduplication nor process cleanup
provides exactly-once guarantees for a third-party service.

## Browser sessions

Install the matching Chromium browser with `bunx playwright-core install chromium`.
Alternatively, set `KRU_BROWSER_EXECUTABLE` to a compatible Chromium executable.
Enable browser access separately for each teammate in settings. Start session
uses a headless browser. Open for sign-in starts a visible browser so you can sign
in directly; stop an existing headless session before starting a visible one.

Each teammate receives a separate context. Cookies and local storage persist in
private `.kru/browsers/<agent-id>/state.json` files (directory 0700, file 0600).
With `--db`, the browser directory is beside that database. Session storage,
downloads, arbitrary JavaScript execution and a general desktop computer-control
driver are not included. Browser servers bind to loopback and have tracked process
ownership for cleanup. This provides web automation, not an independent OS sandbox.

`use_tool` supports browser navigation, reading visible text and element metadata,
CSS-selector clicks, filling fields, key presses, and a screenshot preview. Actions
are serialized per teammate. Non-read actions ask for approval unless explicitly
allowed by the operator. The operator UI can navigate and refresh the current
browser preview directly. Browser and tool output are untrusted data.

## Routines and webhooks

Routines support daily wall-clock time with an IANA timezone, intervals of at
least one minute, and authenticated webhook events. The schedule and queued
delivery update in one transaction. One overdue occurrence is fired after downtime
and the next occurrence is computed from the current time; missed intervals do not
produce a replay storm. A nonexistent DST wall-clock time is skipped; a repeated
wall-clock time runs once per local date. Paused routines do not trigger work.
Daily/interval routines run in `kru daemon` as well as `kru ui`.

Generate a webhook token from its routine row. The token is shown once, stored
only as a SHA-256 hash, and can be rotated. Send JSON to the displayed endpoint
with `Authorization: Bearer <token>` and an `Idempotency-Key` of at most 200
characters. Repeated keys with identical content reuse the existing delivery;
changed content is rejected. Event payloads are bounded and labelled as untrusted
data. The local API does not automatically publish a webhook endpoint to the
internet. Remote senders require an explicitly configured secure ingress.

## Memory and skills

Memory contains editable key/value facts scoped to one agent. Bounded saved
context is included in turn input, and `workspace` can retrieve the full records.
Skills store a name, description and reusable instructions. Run skill creates a
work item with those instructions. Agents can save their own memories
and skills; the UI can edit or remove them. Removed records remain in event history.
There is no cross-agent memory access through the workspace agent tool.

## API and storage

The server listens on `127.0.0.1` only. Its bundled HTML supplies a random session
token; every operator API request and event stream requires `X-Kru-Token`.
Requests validate Host and Origin and reject cross-site API access. Static files
come from an explicit bundle whitelist. User data is escaped in the UI; content
security policy prevents framing and inline scripts. There is no multi-user
authentication, public hosting, or remote administration service in this release.

Core routes:

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/state` | Agents, lanes, workspace records, usage and activity |
| GET | `/api/providers` | Checked local CLI connection states |
| POST | `/api/providers/codex\|claude/refresh\|install\|login\|cancel` | Check or set up an account connection |
| POST | `/api/providers/claude/code` | Forward a sign-in code to the active Claude login |
| GET | `/api/events` | Authenticated server-sent events |
| POST / PATCH | `/api/agents[/:id]` | Create or configure a teammate |
| POST / GET | `/api/agents/:id/messages` | Queue text or retrieve a lane |
| GET | `/api/work` | Projects and work items with execution state |
| POST / PATCH | `/api/work/projects[/:id]` | Create a project or update its workflow |
| POST | `/api/work/items` | Create work (human or agent-assigned) |
| GET / PATCH | `/api/work/items/:id` | Detail/history or revision-guarded update |
| POST | `/api/work/items/:id/comments` | Post a comment with `Idempotency-Key` |
| POST | `/api/work/items/:id/archive\|restore\|resume` | Revision-guarded work controls |
| POST | `/api/records/:kind` | Create task, routine, connector, memory or skill |
| PATCH | `/api/records/:kind/:id` | Edit routine, connector, memory or skill |
| DELETE | `/api/records/memory\|skill/:id` | Remove saved knowledge |
| POST | `/api/records/task/:id/resume\|cancel` | Control a task |
| POST | `/api/records/approval/:id/decide` | Accept or decline an active request |
| POST | `/api/records/routine/:id/run\|token` | Run a routine or rotate its webhook token |
| POST | `/api/records/connector/:id/tools` | Discover server tools |
| POST | `/api/agents/:id/browser/start\|stop\|action` | Control an enabled browser |
| GET | `/api/agents/:id/browser/screenshot` | Current browser screenshot |
| POST | `/api/webhooks/:routine-id` | Authenticated, deduplicated event ingestion |

Migration 10 adds `workspace_records`. Versioned workspace events participate in
the same transaction, ownership fence and replay verification as core domain
events. Migration 11 adds projects, work items, stage runs and activity, all
event-backed. Replay now verifies 27 projection tables. This upgrade is forward-only;
an older KRU binary rejects a database with migration 11. Back up the database
before returning to an older checkout.

## Verification

```sh
bun run typecheck
bun test
bun run test:workspace
bun run test:ui
```

The browser check creates an isolated temporary database, uses scripted providers,
launches a real MCP process, and drives Chromium through the operator UI. It covers
teammate creation, streamed chat, memory, skills, Work projects, stage handoffs, review, drag-and-drop, comments, search,
archive/restore, routines,
connector discovery, approval decisions, browser navigation/fill/click, cookie
persistence and mobile layout. Screenshots and a JSON result go to
`$TMPDIR/kru-workspace-verification`, or `KRU_UI_ARTIFACT_DIR` when set.
Live Codex/Claude model tests remain opt-in. On macOS, ownership/process tests and
Chromium require an execution environment that permits `/bin/ps` and child processes.
