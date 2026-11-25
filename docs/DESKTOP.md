# KRU desktop

KRU is an Electron desktop application. It launches the local engine itself,
connects to Codex and Claude Code installed on the computer, and closes its
engine and owned processes when the application quits. No separate browser tab,
terminal command, hosted frontend, or Bun installation is needed to run a
packaged app.

## Run and build

Development:

```sh
bun install
bunx install-electron
bun run desktop
```

Build the current platform's application:

```sh
bun run desktop:package
```

On this Mac, the result is
`dist/desktop/KRU-darwin-arm64/KRU.app`. Open it normally from Finder.
The packager compiles the Bun engine into an executable, includes migrations and
UI assets, and packages the Electron window and native KRU icon. The current
packaging script targets the build host's platform and architecture.

The development launcher uses a project `.kru/kru.sqlite` when available. A
packaged app uses its application-data workspace. Use **File → Open workspace…**
to select an existing `.kru/kru.sqlite` and keep its Work items, bot settings,
connector accounts, conversations and history. Stop a separate process using
that database first. `KRU_DB` can explicitly choose a database; `KRU_USER_DATA_DIR`
can isolate the desktop profile. GUI launches resolve the user's login-shell
PATH so locally installed Codex, Claude Code, Node and npm can be found.

## Accounts

Sign in on the startup screen using Clerk's email or social sign-in controls.
Sign-in is required before opening the desktop workspace. See [Clerk setup](CLERK.md)
for the selected development application, desktop callbacks, and production setup.

## GitHub

The GitHub card in Plugin saves a personal access token using OS encryption,
scoped to the selected workspace. See [GitHub setup](GITHUB.md) for permissions,
reconnecting, and workflow use.

## Obsidian

KRU's central knowledge and memory live in a dedicated Obsidian vault. See
[Obsidian](BRAIN.md) for its layout and **Plugin → Obsidian** controls.

## Appearance

The appearance button at the bottom of the sidebar offers **Light**, **Dark**,
and **System**. System is the default and follows live operating-system changes.
The selected preference is saved in the desktop profile and restored before
the window loads. The shell, dialogs, workflow editor and native browser use the
same appearance; websites that support a color-scheme preference follow it too.

## Personal chat

Chat is a direct conversation with an LLM. It has no teammate selector or bot
delegation tools. Personal history is separate from the bot conversations opened
by bot avatars and approval reminders. The engine uses a private execution
identity internally to reuse scheduling, approvals and durable session history;
that identity is excluded from the teammate registry exposed in the UI and from
bot discovery/messaging tools.

The model picker follows **provider → model → thinking effort**. Model and effort
options come from the installed CLI, not a hard-coded catalog. Codex uses
`model/list`; Claude uses the Agent SDK's `supportedModels()`. These metadata
queries do not submit user turns or make paid model requests. Selection applies
to the current logical thread and is sent to the CLI when it runs. See
[Conversations](CONVERSATIONS.md) for context handoffs and media limits.

## Local engine boundary

The window loads `kru://app/`. Electron proxies those requests to an ephemeral
loopback engine with a private bootstrap key; ordinary browser requests cannot
open that desktop engine. The renderer also uses the existing session-token API.
The renderer has context isolation, sandboxing and no Node integration. Its narrow
preload bridge only positions native browser views and receives state updates.
Authentication links open in the system browser. External pages run in separate,
sandboxed Chromium WebContentsViews without the application preload.

The globe opens the actual Chromium tab alongside chat. The LLM controls that
same page through the private engine/main-process IPC channel. Native rendering
replaces the former Firefox screenshot and input bridge. No browser executable
or Playwright browser download is needed for the packaged app.

Profiles persist cookies, local storage, IndexedDB and cache separately for each
workspace and agent. **Browser → Import browser data** previews detected profiles
and imports cookies and compatible Chromium cache. Cookie export files are also
supported; cache activation requires restarting KRU. See [Native browser](BROWSER.md)
for supported sources, encryption handling, verification and limitations.

## Verification

```sh
bun run typecheck
bun test
bun run test:ui
bun run test:browser-import
bun run test:browser-performance
bun run desktop:package
bun run test:desktop
```

The shared UI check uses scripted models. Native checks exercise actual Chromium
tabs, direct input, LLM actions on the same page, profile import and persistence
across app restarts. They use fixture browser profiles and submit no paid model
turn. Screenshots and performance reports go to `dist/desktop-verification`.
Native GUI tests require permission to launch desktop apps.

## Sites that reject embedded browsers

The embedded browser uses Electron's bundled Chromium, not the separately installed
Google Chrome application. Browser sessions preserve the actual Chromium version
while excluding app product tokens. Clerk's optional session-label user-agent
override is omitted because it replaces the application-wide browser identity.
This does not guarantee acceptance by a site's verification service.

Use **Open in browser** in the verification banner to open the
active HTTP(S) page in your installed default browser. Make Chrome your system
default if you want that button to use Chrome. This is an explicit user action;
remote pages and agents cannot invoke the desktop bridge. The external browser
has its own cookies/session and isn't controlled by Kru. Completing verification
there does not automatically unlock the embedded session.

## Provider usage limits

The indicator above your profile follows the conversation's selected provider.
The outer ring shows weekly usage; the inner ring shows the shorter window,
typically five hours. Click it for percentages, reset times, and any additional
reported limits. Dotted rings mean that window is unavailable, not zero usage.

Kru reads account metadata through Codex's
[account/rateLimits/read](https://developers.openai.com/codex/app-server)
and Claude Agent SDK's structured usage query. Reads are cached for two minutes
and never send a model prompt. API-key accounts and older CLIs may not expose
subscription limits. Claude's usage query is currently experimental; unsupported
versions fall back to unavailable. Kru does not read credential files or estimate
plan usage from its own token ledger.
