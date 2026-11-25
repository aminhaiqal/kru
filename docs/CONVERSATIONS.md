# Conversations and model switching

Conversations has a searchable thread sidebar, a New conversation action, a
focused chat surface, thread deletion and image attachments. Personal Chat
is directly between the user and the selected LLM, with no teammate selector. Personal history is separate from bot work and approval conversations. New conversations use independent
`chat:<uuid>` lanes. Titles start with the first user message and can be renamed.
Older messages load in pages of 200, without deleting stored history. Mobile
shows the same thread list in a drawer. Draft text survives switching threads.

The composer model button opens **Codex / Claude Code → model → thinking effort**.
Codex's `model/list` and Claude's `supportedModels()` return the actual choices
for the installed CLI and account. The UI offers only that model's supported
efforts, then sends the chosen model and effort to the native CLI. Codex receives
`model_reasoning_effort` and turn `effort`; Claude receives SDK `model`, `effort`
and a matching `CLAUDE_CODE_EFFORT_LEVEL` for the child process. Global CLI
configuration is not rewritten. Provider sign-in is managed in Plugin.

The current metadata queries were verified against Codex CLI 0.171.0 and Claude
Code 2.1.310. Codex returned GPT-6.2 Sol/Astra and its available older models;
Claude returned Default, Opus, Fable, Sonnet and Haiku. The lists remain live
rather than freezing those names into the application. See the official
[Codex model listing](https://learn.chatgpt.com/docs/app-server#list-models-modellist)
and [Claude model and effort configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level).

Model selection is specific to the logical thread. It never changes another
conversation or unrelated Work/Skills execution. An active or queued reply must
finish or be stopped before changing models. Earlier replies show their recorded
provider/model. Personal sessions have history and browser/connector tools but
no KRU teammate messaging, task instructions or automatic bot memory injection.

## Shared projects

The conversation sidebar and Work use the same project records and project editor.
Create a project from either view; names and settings update in both. Expand a
project to see its conversations, use its plus button to start another chat, or
use a conversation's folder action to move it to a project (or back to No project).
Search also matches project names. Moving keeps the thread's history, model,
attachments, and context.

Migration 14 adds an optional project link to existing conversation settings.
Legacy chats stay unfiled. Work-run conversations derive their project from the
Work item, including earlier stage runs. Project links are recorded in the event
log and preserved through replay and restarts.

## How context survives

KRU's logical thread is independent from Codex and Claude's native sessions.
The scheduler resolves a thread's provider/model before starting its runtime,
and the existing session configuration hash detects a model or provider change.
It starts a fresh native generation while retaining the logical thread ID.

The existing session handoff then supplies earlier conversation records to the
new generation. It prioritizes the first exchanges and recent history inside
the configured input budget, and exposes `history_search` to retrieve omitted
or clipped records from the same thread. Full stored history remains available
to the UI and history tools; a switch does not reset or delete it. This is a
bounded context handoff, not a transfer of a provider's hidden internal state.

Bot conversations retain their own instructions, memory, connectors and permissions. Unsupported full-profile settings fall back to the coding
profile when a conversation switches to Codex. File permissions are preserved.

Migration 13 adds the event-backed `conversation_settings` projection, including
title, provider, model, effort, deletion marker and revision. Two media projections
store image metadata and message links. Replay verifies 33 projections. Revisions
prevent stale tabs from overwriting a newer selection. Conversation creation
uses an idempotency key, and loading older pages is scoped to the bot and lane.

## Message formatting

Assistant replies render Markdown, including headings, emphasis, lists, links,
quotes, fenced code, and tables. User messages retain their original text.
Rendering applies to saved history and streamed replies without changing stored
messages. The renderer bundles Marked and DOMPurify locally; HTML is treated as
text, unsafe links are removed, and external links open in the system browser.

## Attachments and deletion

The plus menu offers **Upload or add files** and **Add folder**. Folder selection
imports its files with their relative paths; hidden files and generated directories
such as `node_modules`, `dist`, `build` and `coverage` are skipped. Attach up to
20 files per message, including up to four PNG, JPEG, GIF or WebP images (5 MB each).
UTF-8 text/code files are limited to 128 KB each and 512 KB total. Their contents
are sent as text input to either CLI and restored on a model handoff, using the
most recent 20 attachments within those limits. Binary documents and archives
are rejected with a visible message. Image bytes
are validated, stored privately beside the database under `media/<database-id>`,
and sent as native image input: local-image items to Codex, base64 image blocks
to Claude. Images are visible in message history. A fresh native generation also
receives the most recent four previously sent images, so recent image context
survives a model switch. Older images remain stored and can be attached again.
Back up the media directory together with the database.

The thread's delete control removes it from chat navigation and prevents further
reads/sends through the conversation API. It also removes that thread's image
files and text/code attachments. Existing immutable text events and metadata remain in the local audit
history; deletion is not an event-log erasure. A reply must finish or be stopped
before deleting its conversation.

## Native browser

The globe opens an actual Chromium tab on the right, with tabs, an address bar,
expansion and native input. LLM browser actions use the same page. Persistent
profiles retain cookies, local storage, IndexedDB and cache. **Import browser data**
adds supported browser cookies and compatible cache after profile selection.

The former Firefox process, screenshot polling and synthetic input bridge are
removed. Browser agent permissions remain Ask/Allow, and human verification is
handled directly by the user. See [Native browser](BROWSER.md) for implementation,
import formats and limitations.

## Code and checks

- `src/threads/conversations.ts`: thread metadata and effective model settings.
- `src/scheduler/scheduler.ts`: resolve settings before claiming a lane.
- `src/daemon/sessions.ts`: existing durable generations and context handoff.
- `src/web/client/conversations.js`: thread sidebar, model picker and pagination.
- `src/web/client/browser-panel.js`: native browser panel and navigation controls.
- `src/web/styles/conversations.css`: responsive conversation layout.
- `src/workspace/browser.ts`: native browser IPC gateway, web search and page actions.
- `test/conversations.test.ts`: model isolation, handoff, paging, replay, browser
  defaults, upgrades and conversation approvals.
- `scripts/check-workspace-ui.ts`: scripted provider switching, thread search,
  mobile navigation; native desktop checks cover real browser actions.
