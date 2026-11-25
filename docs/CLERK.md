# Kru accounts

Kru requires Clerk sign-in before entering the desktop workspace. Signed-out
users see a dedicated sign-in screen with no dismiss control. The workspace is
not rendered or loaded until Clerk confirms a session. Signing out returns to
the sign-in screen and discards rendered workspace state. Local files and saved
conversations remain on this computer; signing out does not delete them. Local
workspace data is scoped to the computer/workspace, not to the Clerk account.

The development application is **Kru** (`app_3Ma9YdFnSQCC2ATrAysN2CteaHU`). The
public publishable key is in `desktop/clerk.config.json`. No Clerk Secret Key is
written to the repository or shipped with Electron. `KRU_CLERK_PUBLISHABLE_KEY`
can override the public key at launch. Do not put a Secret Key in this variable.

## Desktop integration

- `desktop/clerk.cjs` configures the SDK's encrypted session storage and OAuth
  transport. Plaintext credential storage is disabled.
- The sandboxed preload exposes the Clerk bridge only to the app's main frame at
  `kru://app/`. Other websites stay in separate native browser views without the
  preload. Navigation and server redirects away from the application origin are
  blocked; external links open in the system browser.
- `src/web/client/account.js` mounts a separate React account control in the
  sidebar. The rest of the workspace remains plain JavaScript. Its bundle loads
  only in the Electron app.
- `scripts/build-desktop-bridges.ts` bundles SDK dependencies for the sandboxed
  preload and packaged main process. Package metadata registers the `kru` URL
  scheme. Social sign-in must be tested in a packaged application on macOS/Linux.
- Clerk's Native API must be enabled, `kru://app` must be in allowed origins, and
  `kru://app/` must be in the mobile SSO redirect allowlist. Development is
  configured with these values. The app's CSP permits only the required Clerk
  services in addition to local resources.

Sign in on the startup screen. The dialog includes email-code
sign-in and GitHub. After sign-in, the account avatar provides account management
and sign-out. GitHub sign-in opens the system browser and returns through a
per-attempt desktop callback handled by Clerk's SDK.

## GitHub login and repository access

GitHub login identifies a Kru user. It does not grant the repository connector
permissions automatically. Clerk's shared development GitHub credentials are
suitable for testing login, but cannot supply GitHub API tokens for the connector.
For repository access, register a GitHub App or OAuth App using the exact callback
URL from Clerk's GitHub connection settings, then configure its custom credentials
in Clerk. Client secrets belong only in Clerk or a hosted backend, never in the
desktop application. Retrieving provider access tokens through Clerk's Backend API
requires a separately deployed backend that authenticates the user's Clerk
session. No such backend is included in this local desktop setup.

## Verification

Run `bun run desktop:package`, then `bun run test:clerk-desktop` for the live
sign-in UI smoke check. It uses an isolated local profile and never submits
credentials or creates a user. `bun run test:desktop` checks local desktop/browser
behavior. `bun run check` and `bun run test:ui` cover the engine and workspace.

Run `bunx clerk@latest doctor --json` to inspect CLI linking. Its generic missing
`.env` warning is expected: the desktop intentionally stores only public
configuration in JSON. Never fix that warning by shipping a Clerk Secret Key.

## Production

The Electron SDK is currently beta. Before distribution, configure a production
Clerk instance with your own domain and public key, repeat the Native API/origin/
redirect settings there, and package with that public configuration. Sign and
notarize macOS builds with your Developer ID for reliable OS-keychain session
persistence. Unsigned local builds can fall back to memory-only session storage;
they never fall back to plaintext.

See [Clerk's Electron quickstart](https://clerk.com/docs/electron/getting-started/quickstart),
[OAuth deep links](https://clerk.com/docs/guides/configure/auth-strategies/oauth-deep-links),
and [production deployment](https://clerk.com/docs/guides/development/deployment/electron).
