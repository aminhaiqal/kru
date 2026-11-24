# Maintaining KRU

KRU has three runtime layers:

- `src/` contains the Bun engine, durable storage, CLI adapters, and local API.
- `desktop/` contains Electron window, native browser, and preload bridges.
- `src/web/client/` contains browser UI modules. `main.js` starts the application;
  `app.js` coordinates state refresh and rendering. Features live in
  `conversations.js`, `work.js`, `workflows.js`, `connectors.js`, and `approvals.js`.
  `state.js`, `api.js`, `dom.js`, and `forms.js` provide shared utilities.

## Sources and generated files

Edit JavaScript in `src/web/client/` and CSS in `src/web/styles/`. The theme entry
runs before styles load to avoid a flash; it must not import application startup
or depend on the page body already existing. Other features use explicit imports
and start through `main.js`, after all modules have loaded.

Run `bun run build:web` after changing frontend sources. It creates the local
`app.js`, `theme.js`, and `style.css` served from `src/web/public/`, along with
third-party license notices. These generated files are checked in so the local
engine can serve the UI without a separate development server. Do not edit the
bundles directly. `src/web/public/index.html` is the handwritten document shell.
Tailwind Preflight is deliberately omitted to preserve the application controls.

`bun run desktop:package` builds these assets and the engine before packaging
Electron. Packaging recreates the staging resources so removed files do not
remain in subsequent builds.

## Checks

- `bun run check`: frontend/native JavaScript lint, Knip dead-code checks, TypeScript (including unused
  imports and parameters), and engine tests. Live provider tests stay opt-in.
- `bun run lint:dead`: unused files, exports, and dependencies, with explicit entry
  points for the engine, desktop, UI, scripts, tests, and example programs.
- `bun run format` / `bun run format:check`: format/check handwritten source.
- `bun run test:ui`: UI fixtures exercise chat, connectors, work, workflows,
  approval reminders, themes, and responsive layouts without paid model calls.
- `bun run test:desktop`: native bridges and browser behavior against the packaged
  app, using an isolated profile. Run `desktop:package` first.
- `bun run test:browser-import` and `bun run test:browser-performance`: isolated
  browser import and performance checks.

When retiring UI, remove its renderer, event handlers, and styles together.
Check references before removing exports, CLI commands, API routes, migrations,
or persisted record formats: these may still support automation, replay, or old
workspaces even when they have no standalone page. Routine execution, private
memory, and approvals in conversations remain active engine features.
