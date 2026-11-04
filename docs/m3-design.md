# M3 design decisions

These decisions refine the scheduler milestone in the
[Kru project plan](Kru%20%E2%80%94%20Project%20Plan%20%26%20Milestones.pdf).
They are requirements for M3 and pre-v0.1 work; M2 does not yet implement batching,
a daemon or idempotency expiry.

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
immediate local wakeups. This follows [SQLite's documented semantics](https://www.sqlite.org/pragma.html#pragma_data_version).

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
can share one turn. M3 adds `claimBatch` to the mailbox port and a new migration
with `deliveries.batch_id` plus a small `active_lanes` table:

```sql
CREATE TABLE active_lanes (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  lane_key TEXT NOT NULL,
  batch_id TEXT NOT NULL UNIQUE,
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
because a timer elapsed. M7 recovery must reconcile interrupted batches and
release stale reservations before normal scheduling resumes.

Before switching the scheduler to this API, test competing processes on both
the main and side lanes, independent lanes progressing in parallel, atomic
rollback, original queue order after restore, and stale batch releases. Preserve
`claimNext` for existing consumers, but require it to respect active batch
reservations once M3 is shipped; all scheduler execution uses `claimBatch`.

## Idempotency retention before v0.1

Retain a key for at least 30 days from the original message's creation time.
Replays do not extend the expiry. Pin expired keys while any original delivery
or retry remains queued, starting or running; pending work must not duplicate
because it aged out. Once expired and all attempts are final, the key may be
reused for a new command and receipt.

A later migration adds an explicit expiry timestamp and an index. Clear the
expired key and request hash together, without deleting messages, deliveries
or retry history. The enqueue transaction checks expiry for the requested key
before duplicate/conflict handling, so reuse does not depend on when background
cleanup last ran. Bounded maintenance clears other eligible expired keys.
Pruning and enqueue share the writer lock; concurrent reuse must still produce
one receipt. Message-history retention is a separate policy: pruning keys alone
does not remove historical messages.

Expiry remains disabled in M2. Ship the migration, lookup/pruning logic,
documentation and boundary/concurrency tests before v0.1. Tests must include the
30-day boundary, no expiry extension on replay, pinned open attempts, retained
history, and concurrent reuse after expiry.
