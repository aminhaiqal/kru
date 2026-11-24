# Native browser

KRU uses Electron `WebContentsView` tabs for local browsing. The same Chromium
page is displayed in the right panel and controlled by the LLM. Mouse, keyboard,
clipboard, selection, scrolling and media use the native page. Expanding the
panel changes the view's bounds; it does not turn a screenshot into a browser.

The previous Firefox process, screenshot polling, synthetic input proxy,
coordinate scaling and frame/input API routes have been removed. Playwright is
now a development dependency for UI verification only. No separate browser
download is required to use the packaged application.

## Ownership and isolation

- `desktop/browser-host.cjs` owns the tabs, profiles, operation queues, popups and
  native views. The app renderer has a narrow preload API for layout and state
  notifications; external websites receive no preload or Node access.
- `src/workspace/browser.ts` is the engine's typed IPC gateway. Browser requests
  and state travel on the private parent/child process channel. No browser
  automation port is exposed. Cancellation and parent disconnect are handled.
- `src/web/public/browser-panel.js` owns the address bar and tab controls. It
  places a native view in its surface and hides it while an app dialog is open.
  There is no image stream or per-keystroke HTTP transport.
- Profiles use persistent Electron partitions keyed by workspace and agent ID.
  Cookies, local storage, IndexedDB and cache remain in that profile. Human
  browsing and LLM actions use the same session. Closing the panel does not stop
  the browser; Stop destroys its tabs and flushes session storage.
- Agent actions retain the existing Ask/Allow policy. Tools use CSS selectors
  returned by snapshots, isolated-world DOM inspection, and CDP input commands.
  The Runtime domain is not enabled. The application window stays on `kru://app`.

Popups become managed tabs in the same profile. Browser identity uses the actual
installed Chromium engine; KRU/Electron application tokens are removed from its
user-agent string. There are no fake WebDriver, GPU, or CAPTCHA-solving scripts.
Recognized human-verification pages ask the user to complete the check in the
native tab. A native browser cannot guarantee that sites never challenge it.

## Importing browser data

Open **Browser → Import browser data**, choose a detected profile, and select
cookies and/or compatible Chromium cache. Discovery previews profile metadata;
it does not import anything automatically.

Supported sources:

| Source | Cookies | HTTP cache |
| --- | --- | --- |
| Chrome, Edge, Brave; Chromium on Linux | Source browser decrypts its own cookies | Staged when available |
| Firefox | Read from a read-only SQLite connection | Incompatible with Chromium |
| Previous KRU Firefox session | Selected saved cookies | Incompatible with Chromium |
| JSON cookie arrays / `{cookies: [...]}` / Netscape cookies.txt | Choose cookies file | Not included |

Encrypted Chromium cookies are exported through the original browser using a
temporary, minimal profile clone and a private debugging pipe. The clone copies
the cookie database through SQLite backup, plus Local State, and opens only
`about:blank` with sync/extensions/background networking disabled. The OS may ask
for access to its encryption key. The clone and helper process are removed when
finished. If decryption fails, the result explains it and offers file import.
KRU does not silently import encrypted blobs and claim the sign-in succeeded.

Cookie values never appear in the profile list, logs or import report. Expired,
invalid, unsupported partitioned cookies and Firefox container cookies are not
merged into the destination profile. Source browser databases are read-only.
Only the KRU profile selected through the current conversation receives data.

Cache is staged privately and activated before the target partition is opened
on the next KRU start. A restart is required for an already open profile. Only
compatible Chromium HTTP cache is copied; symlinks are skipped. Chromium may
discard cache entries from an incompatible browser version. History, passwords,
extensions and bookmarks are not imported. Some websites require signing in
again regardless of imported cookies.

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

The native test uses isolated fixture profiles to verify imports and browser
storage across application restarts. Import tests cover the private helper pipe,
source preservation, cookie export formats, cache staging and path boundaries;
they do not read real user sign-ins or test OS keychain prompts.

The local performance check launches Electron without automation/debugger flags
and visits only a local fixture. It measured 60 animation frames per second and
`navigator.webdriver === false`, versus an estimated 1.49 FPS for the previous
snapshot loop on the same machine. This is a local rendering measurement, not a
guarantee of website performance or exemption from bot protection. Its report is
`dist/desktop-verification/browser-performance.json`.

## Architectural references

The design follows OpenBot's native-tab and persistent-session concept, without
copying its browser implementation:

- [OpenBot browser host](https://github.com/nightly-labs/openbot/blob/main/src/backend/browser-host.ts)
- [OpenBot browser architecture](https://github.com/nightly-labs/openbot/blob/main/docs/architecture/browser.md)
- [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)
- [Electron persistent sessions](https://www.electronjs.org/docs/latest/api/session)
