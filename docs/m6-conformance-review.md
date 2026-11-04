# M6 conformance review — 2026-11-05

**Resolved in the expanded M6 follow-up.** The original findings and probe outputs
below describe the pre-fix working tree and are retained unchanged as historical
evidence. They are not the current implementation status. See [M6 notes](m6.md)
for the final architecture and eighteen-case mapping, and the
[follow-up verification](verification/m6-expanded-2026-11-05.json) for results.
The fixes cover durable setup/CAS and cleanup, replayable generations/packets/use,
source/attempt provenance, adapter error classification, signed snapshot cursors,
source-ID lookup, bounded Unicode packets and recoverable retrieval failures.

**Original audit verdict (before remediation): the implementation did not satisfy the expanded M6 specification.**
It implements the earlier milestone brief, with useful M7 ownership/recovery
additions, but the current [PDF](Kru_Project_Plan_and_Milestones.pdf), printed
pages 59–66, requires substantially more lifecycle, provenance and retrieval work.
The M6 completion claim must be scoped to the earlier brief until these gaps close.

This review includes the uncommitted M7 working tree over v0.1.1 (`bc3753a`).
Production code was inspected without modification. The existing M6 suite was
rerun: **180 passed, zero failed**, eighteen existing tests repeated ten times.
Those are not a one-to-one implementation of the PDF's eighteen numbered cases.
Passing them does not establish expanded-spec conformance.

Additional isolated probes made zero model calls and changed only temporary
databases. [Observed results](verification/m6-conformance-probes-2026-11-05.json)
and [probe source](verification/m6-conformance-probes.ts) are retained.

```sh
bun run test:threads:repeat
bun docs/verification/m6-conformance-probes.ts
```

## Findings requiring correction

### P1 — Native setup and activation lack the specified durable protocol

`src/scheduler/session.ts:38` creates a session before calling `sessions.put`.
There is no session setup-intent/candidate record, expected-generation input,
lane-ownership check or compare-and-set activation. `src/daemon/sessions.ts:22`
deactivates all current bindings and unconditionally upserts its candidate.
M7's process-spawn intent tracks an OS runtime; it does not record a native
`thread/start` setup intent or its unresolved candidate.

The probe injects a binding-insert failure after a successful native create.
The new native session remains resumable, with no binding and no setup/candidate
record. The manager has not retained the identity needed to settle that setup
attempt. This directly misses M6/04, M6/07 and acceptance case 8. A generation
race is also not guarded by the required activation compare-and-set, even though
the normal single-daemon lane reservation prevents many ordinary races.

### P1 — Session lineage and handoff use are not event-sourced

M7 adds `generation_id`, but it is a random operational UUID. It is not a
monotonically increasing per-thread generation, and ordinary replacement facts,
reasons and retired lineage have no domain projection/events. The table key is
still `(agent_id,lane_key,provider)`, so switching back overwrites the previous
row for that provider (`src/daemon/sessions.ts:25`). M7 boot quarantines record
some uncertain generations; they do not supply normal M6 session lineage.

`SessionBinding` has no runtime/account scope hash, and `sessionConfigHash`
hashes provider, cwd, model, prefix and permissions only
(`src/scheduler/session.ts:18`). A provider identity/account scope change is not
represented in the binding-compatibility contract.

Handoff preparation reads live history each time and returns text
(`src/daemon/sessions.ts:34`). No stored packet, renderer version, source event
cutoff, included/omitted ids, hash, switch reason or handoff id exists. A confirmed
start only clears `handoff_pending` operationally (`src/daemon/sessions.ts:40`),
without recording which execution used which packet. The event catalog confirms
there are no handoff creation/use or normal generation activation events.

The probe produces different packets for the same pending binding after adding
recorded history; there are zero handoff event types. Replay parity over the
existing tables therefore cannot prove replayability of the missing facts.
This misses M6/02, M6/04 and M6/05.

### P1 — History retrieval is recursively indexed as conversation evidence

`src/threads/history.ts:21` searches stored tool `details_json`, and line 26
includes every `dynamicToolCall`. A `history_search` call's saved result contains
the retrieved excerpts. Later searches return those copies as new facts.

The probe performs one retrieval and then finds that very retrieval result as a
`dynamicToolCall` match. M6/06 explicitly forbids this recursive ingestion.
Keep the invocation/result in the audit log, but exclude derived retrieval bodies
from canonical searchable evidence.

### P1 — Missing-session classification can replace on an authentication error

`src/scheduler/session.ts:33` classifies errors by message regex in the engine.
An injected `RpcResponseError(-32001, "Session credential missing")` matches it,
so the manager starts a replacement instead of holding the compatible binding.
The probe observed one replacement and no setup hold.

The PDF requires provider-specific classification in adapters, with typed
missing/auth/rate-limit/transport outcomes at the engine boundary. The existing
transient-service-error test is useful but does not cover this ambiguity.
This misses M6/03, M6/07 and acceptance cases 4/18. The injected wording proves
the classifier weakness; this review does not claim a live provider emitted it.

### P2 — Canonical history duplicates retried source messages and drops provenance

Input history is keyed by `delivery:<attempt-id>`
(`src/threads/history.ts:11`). Retrying the same source message creates another
user history row. The probe found two user records for one source message id.
The PDF requires one source message plus separate execution-attempt evidence.

Returned history omits the underlying source message id, execution id, agent
sender id, reply relationship and chain/hop. Those facts remain in the mailbox,
but the canonical history/packet interface does not expose them. `turn_threads`
links turns; there is no explicit event-sourced message-to-thread linkage. This
does not meet M6/02 or M6/05's evidence/provenance contract.

### P2 — Pagination has no fixed snapshot and trusts caller-supplied positions

The cursor contains thread/query and ordering values, without `snapshotSeq`
(`src/threads/history.ts:80`). Each page reads current committed data. The probe
appended a committed item to an older execution after page one; page two then
included that post-snapshot item. Ordinary newly sequenced turns often behave
well with the current keyset ordering, but the specified immutable snapshot is
not implemented.

Changing the cursor's ordering tuple to another nonnegative integer position is
accepted (`src/threads/history.ts:61`); the source anchor is not validated. This
does not bypass the agent/lane SQL scope, but it can silently skip history rather
than reject an invalid cursor. Exact-entry reads also lack a fixed snapshot.
This misses M6/06 and acceptance cases 13/14.

### P2 — Search database failures stop the daemon

History input errors return unsuccessful tool results. Database errors are
rethrown by `src/tools/router.ts:56`; `src/scheduler/scheduler.ts:199` then calls
`fail`, stopping the daemon. A probe made the history SQL function throw and
observed daemon failure. The expanded search contract requires a tool error,
distinct from no matches. Returning that error should not itself escalate an
otherwise recoverable retrieval failure to a global engine shutdown.

### P2 — Retrieval and packet contracts differ from the expanded spec

The tool accepts `entryId`/`offset`, not exact source `messageId`; default and
maximum limit are both five instead of the specified six/default and twenty/max.
Results use `entries` and lack `snapshotSeq`, `executionId`, explicit
`truncated`/`omitted` and known-history-gap reporting. Id retrieval cannot address
the original source message id directly. See `src/tools/definitions.ts:15` and
`src/threads/types.ts`.

The packet defaults to 6,000 UTF-16 code units; the PDF proposes 12,000 Unicode
code points. A smaller configurable ceiling is a defensible design choice, but
it should be distinguished from conformance to the proposed default. The fixed
ceiling is respected, and current input stays outside the stable prefix. Missing
packet persistence, switch reason, provenance, omission metadata and explicit
byte-budget contract are more substantial than this default-size difference.

Migration chooses one newest binding with provider-name tie breaks
(`src/threads/migrate.ts:18`) rather than treating ambiguous lineage as requiring
a fresh generation, and it records no pre-M4 history-unavailable marker.
The upgrade/replay tests cover existing data preservation, not these new rules.

## PDF acceptance-case coverage

“Covered” below describes the tested functional behavior, not a waiver of the
architectural gaps above. “Partial” means some behavior exists but the full
specified scenario/assertions are missing. “Gap” means a reproduced mismatch or
required mechanism is absent.

| PDF case | Status | Evidence / remaining work |
| --- | --- | --- |
| 1. Ten turns, provider switch, recall turn one | Partial | Scripted Claude→Codex demo passes; its first fact is deliberately included in the packet. Omitted-fact provider-switch recall is not demonstrated. |
| 2. Restart with valid native binding | Covered | Resume test preserves native identity and does not inject duplicate handoff. |
| 3. Missing cache replacement | Partial | Fake-backed replacement/handoff works; durable generation lineage and per-adapter missing-cache coverage are incomplete. |
| 4. Auth/rate-limit/transient resume errors | Gap | Transient service hold tested, but the injected credential error causes replacement. |
| 5. A→B→A uses a fresh A | Covered | Switch-back test checks fresh native identity and intervening history. |
| 6. Change provider/config during a running turn | Partial | Config hashing and drain-boundary structure exist; the session test changes config after completion, not during a blocked running turn/setup. |
| 7. Race setup/activation; stale events | Partial | M7 epoch/execution guards exist; generation CAS and the activation race case are absent. |
| 8. Create timeout, activation failure, pre-start crash | Gap | Pending flag survives setup-only restart; candidate/setup protocol is missing and failed activation leaves an untracked session. |
| 9. Lost accepted start response | Partial | M3 prevents automatic resend; adapter tombstones and M7 boot quarantine exist. Live ordinary retirement does not record M6 lineage/packet association. |
| 10. Unicode/history/current-input bounds | Partial | Existing tests verify current UTF-16/byte limits and current-input exclusion; proposed code-point semantics and persisted packet evidence differ. |
| 11. Handoff once per generation, stable prefix | Partial | Pending flag clears on confirmed start; no replayable packet-use association or normal generation history. |
| 12. Retrieve omitted first-turn evidence | Partial | Entry continuation works, including a long answer's tail. The switch demo does not force omitted evidence, and original source-id lookup differs. |
| 13. Cross-agent/lane and tampered cursor | Partial | Scope isolation and foreign-query/thread rejection pass; edited ordering positions are accepted. |
| 14. Append between pages; DB error | Gap | Probe observes a post-page-one item and a database error stops the daemon. |
| 15. Migration and deterministic replay | Partial | Existing fourteen projections replay; required lineage/packet/message-link facts have no projections to verify. |
| 16. M5 request/reply through replacement | Partial | M5 routing stays durable and M7 tests preserve committed sends; a complete M6 request/reply-through-replacement case is not present. |
| 17. No hidden turns; correct ledger | Partial | Runner remains sole turn-start path and demo checks eleven linked turns; the complete expanded scenario needs an explicit starts/ledger assertion. |
| 18. Missing/switch behavior through every adapter | Partial | Real adapters are exercised with scripted native traffic, but the missing/auth/replacement matrix is not run for each adapter. |

## Recommended completion order

1. Add event-sourced monotonic generations, replacement reasons and runtime-scope
   compatibility; retain retired lineage and activate with lane/generation CAS.
2. Add durable native setup intents/candidates and atomic packet activation, with
   renderer/hash/cutoff/source metadata and confirmed execution-use events.
3. Correct canonical source/attempt provenance and exclude retrieval-result bodies.
4. Implement snapshot-bound search/read cursors and source-id lookup; classify
   adapter errors and return recoverable retrieval failures as tool errors.
5. Implement the PDF's eighteen named acceptance scenarios, including omitted
   facts and per-adapter failures, and repeat them ten times before claiming M6
   complete against this expanded plan.

The prior test counts and M7 release test passes remain valid observations.
They do not establish the expanded M6 completion criterion. This conformance
work should precede claiming the expanded roadmap is fully satisfied for v0.2.
