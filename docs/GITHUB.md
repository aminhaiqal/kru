# GitHub plugin

Open **Plugin → GitHub → Connect** and paste a GitHub personal access token.
The form links to GitHub's token creation page, where you choose the repositories
and GitHub permissions it can access. Kru uses
[GitHub's official hosted MCP server](https://github.com/github/github-mcp-server#remote-github-mcp-server).

GitHub is available throughout the current workspace: personal chats, all bots,
Work, and Skills workflows share the same connection. GitHub tool calls run
automatically without Kru approval prompts. GitHub still enforces the token's
repository access and scopes. Disconnect disables access everywhere.

The card shows **Connected** after successfully discovering tools. Click it
to access **View tools**, **Edit**, or **Disconnect**. Existing GitHub records also
receive platform-wide access without changing their persisted ownership/history.
Other app connectors retain their existing scope and permission behavior.

## Credentials

Desktop saves the token with Electron `safeStorage` OS encryption in a
workspace-specific file under the desktop profile's `credentials/` directory.
The file has owner-only permissions. Plaintext-storage fallbacks are rejected.
The token moves to private engine memory over IPC before scheduling begins and
is kept out of connector records, SQLite events, API state, and provider child
process environments. Native websites do not receive the credential bridge.
Editing the token invalidates existing GitHub sessions before reconnecting.

For the local web/CLI UI, or when an OS keyring is unavailable, start KRU with a
raw token in `GITHUB_TOKEN` or `GH_TOKEN`. Normal custom MCP connectors continue
to use their existing environment references. The reserved `KRU_GITHUB_TOKEN`
reference resolves only for the official GitHub connector's Authorization
header, so it cannot forward the desktop credential to a custom server or MCP
process.

## Verification

`bun test test/github.test.ts` checks credential persistence and workspace
isolation, MCP discovery/calls, platform-wide access, automatic permissions, and disabled connections, credential
routing, and error redaction. The UI check exercises setup, reconnect, and a
GitHub workflow against an in-process MCP fixture. Desktop checks use a synthetic
token in an isolated profile to verify OS encryption, engine acknowledgment,
bridge isolation, and persistence across restart. These checks do not contact
GitHub or modify a real GitHub account.
