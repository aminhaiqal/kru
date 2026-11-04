# M3 design decisions

These decisions refine the scheduler milestone in the
[Kru project plan](Kru%20%E2%80%94%20Project%20Plan%20%26%20Milestones.pdf).
The scheduler and batching are implemented in M3; see the
[implementation record](m3.md). Idempotency expiry remains pre-v0.1 work.

## One project database

`kru init` creates `.kru/kru.sqlite`. CLI commands and the future daemon use the
same resolver: explicit `--db`, then `KRU_DB`, then the nearest ancestor `.kru/`.
Discovery fails when no initialized mailbox exists. The daemon resolves once at
startup and holds that absolute path and connection for its lifetime. It must
not rediscover based on a later working-directory change.

## Cross-process wakeups

Use `PRAGMA data_version` on the daemon's long-lived connection every 100 ms.
An initial queue scan is mandatory. A version change triggers queue queries;
an unchanged value needs no queue scan. Compare samples from the same connection
only; reopening the connection requires a new baseline and initial scan.
Local commits do not change that connection's value, so retain `onChange` for
immediate local wakeups. The Store owns this bus; both mailbox writes and agent
configuration writes publish after commit. Scheduler subscribers do not need
manual refresh calls. This follows [SQLite's documented semantics](https://www.sqlite.org/pragma.html#pragma_data_version).

Sample the version before scanning queues and retain that sampled value. A
concurrent commit during the scan will either be visible in the scan or trigger
the next version comparison. Do not sample again after scanning and mark unseen
work as already handled. Keep reads short; do not poll inside a long-lived read
transaction. Slot releases, budget changes and turn completion independently
reschedule held lanes even without a database version change.

The test in `test/store.test.ts` confirms that a second connection's commit
changes the observed value, while local commits and rolled-back writes do not.

## One active batch per lane

The invariant is one active **batch**, not one active delivery. Several messages
can share one turn. M3 implements `claimBatch` on the mailbox port and migration v2
with `deliveries.batch_id` plus a small `active_lanes` table:

```sql
CREATE TABLE active_lanes (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  lane_key TEXT NOT NULL,
  batch_id TEXT NOT NULL UNIQUE,
  turn_id TEXT,
  started_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, lane_key)
) WITHOUT ROWID;
```

Normalize the main lane to `lane_key = ''`; side-lane ids are already required to
be nonempty strings. Do not use nullable `lane_id` in the primary key: null must
not allow several owners of the same main lane.

In one `BEGIN IMMEDIATE` transaction, `claimBatch` checks the lane reservation,
selects eligible deliveries by seq, inserts the reservation, and compare-and-set
claims the selected rows to `starting` with one shared batch id. No eligible
work means no reservation. An existing reservation means the lane is busy and
no deliveries change. The database constraint remains the final guard against
a scheduler accidentally starting two concurrent batches.

Consecutive eligible user messages may share a batch; do not batch across a
sender/cause boundary or another lane. Starting a provider turn happens only
after the claim transaction commits. All batch members share the confirmed turn
id. Finishing the entire batch and removing its matching reservation happen in
one transaction. A release must match the batch id so a stale completion cannot
release another batch's reservation.

Known pre-start failures may restore the entire batch to its original queued
positions and release its reservation atomically. Unknown outcomes become
interrupted and do not automatically retry. Never steal a reservation solely
because a timer elapsed. M3 boot recovery marks abandoned batches interrupted and releases their
reservations before providers start; M7 adds richer reconciliation.

Regression tests cover competing processes on both main and side lanes,
independent lanes progressing in parallel, atomic rollback, original queue order
after restore, and stale batch releases. `claimNext` remains available for
existing consumers and respects active batch reservations. All scheduler
execution uses `claimBatch`.

## Idempotency retention before v0.1

Retain a key for at least 30 days from the original message's creation time.
Replays do not extend the expiry. Pin expired keys while any original delivery
or retry remains queued, starting or running; pending work must not duplicate
because it aged out. Once expired and all attempts are final, the key may be
reused for a new command and receipt.

Migration v6 implements this policy with an index over original creation time;
expiry is derived as `created_at + 30 days`, so no mutable expiry timestamp can
be extended by replay. Clear the
expired key and request hash together, without deleting messages, deliveries
or retry history. The enqueue transaction checks expiry for the requested key
before duplicate/conflict handling, so reuse does not depend on when background
cleanup last ran. Bounded maintenance clears other eligible expired keys.
Pruning and enqueue share the writer lock; concurrent reuse must still produce
one receipt. Message-history retention is a separate policy: pruning keys alone
does not remove historical messages.

Expiry was disabled in M2; the v0.1 implementation now enforces it during enqueue
and prunes at most 100 eligible keys on each ten-second daemon heartbeat.
`test/release.test.ts` covers the exact 30-day boundary, no extension on replay,
pinned open attempts/retries, retained history, rollback and concurrent reuse.
Durable native tool command receipts remain retained, independently of mailbox-key
expiry, so an old call cannot accidentally execute twice.


## Follow-up lifecycle decisions

Codex thread retirement must not kill a healthy shared process. Keep a runtime
tombstone for the abandoned native thread, cancel any late `turn/started`, and
suppress its output and requests. Probe with local `config/read` after timeouts;
only an unanswered probe warrants a shared restart. Claude can terminate its
individual process. The engine uses the `retireThread` provider port operation.

Heartbeats run every ten seconds; status snapshots write only when they change.
PID/start identity, not heartbeat age, determines ownership. Boot recovery keeps
native session bindings so the next delivery can attempt resume.

Budget days default to the host's local timezone, with an explicit daemon
`--budget-timezone` override. The [first M4 foundation](usage-and-pricing.md) now persists token and estimated-USD
accounting, including interrupted/unknown-cost turns and restart regressions before
the broader event/projection work.
