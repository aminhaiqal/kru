# Obsidian

KRU uses a dedicated Obsidian vault as its central knowledge and memory store.
The desktop default is `Documents/KRU Brain`, separate from other Obsidian
vaults. `KRU_BRAIN_VAULT` can explicitly choose a different dedicated location.
Terminal workspaces otherwise use `KRU Brain` next to their database.

## Using the vault

Open **Connector → Obsidian** to see the real vault path and note counts.
**Open in Obsidian** opens the vault once it is registered. On the first use,
KRU opens Obsidian's vault manager and shows the folder to select with **Open
folder as vault**. **Open folder** opens the same location in the file manager.
Obsidian does not need to be running for KRU to read or write its Markdown.
No community plugin, cloud account, or API key is required.

- `KRU Brain.md` explains the vault.
- `Knowledge/` is the default location for shared project notes and decisions.
  Ordinary Markdown notes elsewhere in the vault are shared too.
- `Memory/Personal/<identity>/` contains personal chat's private memories.
- `Memory/Bots/<identity>/` contains each bot's independent private memories.
- `.kru/` tracks completed legacy imports. Keep it when moving the vault.
- `.trash/` contains notes forgotten through KRU, for recovery.

Notes are plain Markdown with Obsidian-compatible YAML properties and wikilinks.
Edit the body of managed memory notes freely; their `kru_owner`, `kru_key` and
`kru_id` properties preserve identity and should stay unchanged. Shared notes
can be created normally in Obsidian. KRU preserves their existing properties
when updating their body.

## Retrieval and updates

Every turn retrieves bounded shared knowledge and the current identity's private
memory. Codex, Claude Code, personal chat, bot conversations and workflow turns
use the same vault. Models receive tools to search, read, update and forget notes;
their instructions ask them to maintain durable facts and preferences as they
work. Model execution continues to use the connected AI accounts.

The vault files are authoritative. Reads check file metadata and reload changed
contents, so Obsidian edits and deletions take effect on the next turn or tool
retrieval. A deleted memory is not restored from the SQLite audit during later
starts. Previously saved database memories are imported once per workspace,
without overwriting notes already present in the vault.

Private-memory updates also retain the existing SQLite event/audit projection.
SQLite remains the store for conversations, runs, approvals and other operational
state; Obsidian is the knowledge store. Do not expect deleting a memory to remove
historical conversation messages or an older audit event.

The `workspace` tool supports:

| Action | Inputs | Result |
| --- | --- | --- |
| `brain_search` | `query`, optional `limit` | Relevant note paths, previews and hashes |
| `brain_read` | `path` | Current body and content hash |
| `brain_write` | `path`, `text`, `expectedHash` for an existing note | Atomic shared-note update |
| `brain_forget` | `path`, `expectedHash` | Move a shared note to the vault trash |
| `memories` / `remember` / `forget` | Existing key-based memory inputs | Private memory for the requesting identity |

Existing-note writes require the hash from a recent read. If an Obsidian edit
changes the note, KRU asks the model to read it again rather than replacing a
stale version. Synchronous temporary-file replacement avoids partial documents.
A filesystem write and SQLite audit commit are separate storage operations;
the Markdown remains authoritative if a process crashes between them.

Retrieval is local text matching with a bounded prompt, not an embedding service.
It scans up to 2,000 Markdown files and 16 MB of shared text per retrieval. Reads
accept notes up to 128 KB; model writes accept up to 32 KB. Hidden folders,
symlinks, paths outside the vault and another bot's private-memory folder are
excluded from model access. Notes are treated as untrusted data, never as new
instructions. Avoid storing credentials in knowledge notes.

## Verification

`test/brain.test.ts` covers Markdown editing, shared recall, personal chat,
private-memory isolation, migration, deletions, optimistic updates, Unicode
context limits and path/symlink boundaries. The shared UI and desktop checks
verify the Connector card and Obsidian/folder controls using isolated vaults.

References: [Obsidian vaults](https://help.obsidian.md/vault),
[properties](https://help.obsidian.md/properties), and
[Obsidian URI](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI).
