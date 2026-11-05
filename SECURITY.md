# Security and recovery boundaries

Kru uses each provider's permissions. It adds no independent sandbox. Treat
workspace-write access, shell commands and external tools as acting with the
permissions granted to that provider. The daemon declines interactive native
approvals; native sandboxed commands can still run according to provider rules.

SQLite and ownership files are trusted local state. Keep the database and its
process-record directory private to the user running the daemon. New ownership
files use mode 0600 and their directory is created with mode 0700. Host identity,
process start identity and daemon epoch prevent accidental PID-reuse/takeover;
they do not defend against another process that can edit Kru's trusted state.

Recovery gates execution while it verifies old work and owned process trees.
Unknown attempts become interrupted. Boot never retries them. File edits,
commands and remote effects may already have occurred, so inspect those effects
before explicitly retrying. Kru cannot make external effects exactly-once.

Native process containment is supported on Linux and macOS, with `/bin/ps`
available. Linux also needs readable `/proc`; macOS needs process inspection and
the platform UUID. Process-group membership is sampled once a second, persisted
only when it changes. An exited leader with unrecorded descendants blocks
startup. Detached descendants and actions outside verifiable group ownership
cannot be guaranteed contained. Windows containment is unsupported and startup
reports that limitation.

Partial output and usage are checkpointed at most every two seconds. Output
after the last committed checkpoint can be lost. Unknown usage holds finite
agent budgets until an operator records a conservative bound; this is an
accounting decision, not proof of exact cost or permission to retry.

New stored provider error strings redact common credential patterns and are
bounded. This is not general secret detection: messages, tool results, historical
events, raw provider stderr and user-written notes can contain secrets. Do not
publish databases or raw diagnostic artifacts without reviewing them.

For operational recovery, use `kru recovery inspect --json`, `kru log <agent>`
and [the recovery specification](docs/Kru_Project_Plan_and_Milestones.pdf#page=67). A usage acknowledgement cannot bypass
unresolved process containment.
