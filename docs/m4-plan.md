# M4 — Implementation order

## First task: durable budget accounting

The [durable usage/pricing foundation](usage-and-pricing.md) is implemented ahead
of the broader history/projection work. It adds the schema-v3 turn ledger, dated
model/cache-lifetime price snapshots, `kru cost` estimates and combined token/USD
gates. Known spending survives restart, and submitted unknown outcomes remain
held until reviewed. General event/receipt replay and full pipeline accounting
are still further M4 work.

The foundation implements these requirements; extend and retain them as M4 proceeds:

1. Add the per-turn usage ledger and the minimal transactional event/receipt
   support it needs. Key records by stable provider/thread/turn identity and
   retain the agent, causing deliveries/chains, model, token counters, timestamps
   and whether the values are estimated. Include model input, cache reads,
   cache writes by lifetime, output rates and the exact price snapshot used.
   Retain unknown-lifetime bounds rather than assuming every write is 5-minute.
2. Checkpoint observed usage while a turn is active. Replace a turn's latest
   snapshot; never add repeated cumulative snapshots. Complete the final usage
   record in the same transaction as the turn's final delivery state.
3. Rebuild daily totals from SQLite before any provider or drain starts. Compute
   the calendar window in the selected budget timezone, including DST. A daemon
   restart or timezone override must not erase already recorded token usage.
4. Preserve interrupted/unknown-cost records. Missing usage is not zero usage:
   hold uncertain consumption conservatively until reconciliation or an explicit
   person-authorized release rather than silently replenishing the budget.
5. Read both token and dollar gates and status totals from the durable ledger.
   `kru cost` shows USD with an explicit estimate/scope label. Unknown prices do
   not become zero cost. Expand main-agent estimates to trustworthy per-model
   query-pipeline baselines before claiming complete account spending. Keep the
   no-automatic-retry rule for turns with unknown outcomes.

Acceptance coverage comes before general message-history work: graceful restart,
repeated SIGKILL/restart, duplicate usage events, a crash between usage and
completion, partial/unknown usage, concurrent lanes, local-midnight/DST boundaries
and a timezone change. None may reset or double-count known spending. A spent
budget must remain held after restart; raising the limit must still resume work.

## Then: general events and projections

Extend the transactional dispatcher, command receipts and projection replay;
add durable messages and buffered delta flushing, then `kru log` and `kru cost`.
The cost views and budget gates must agree with the same durable usage records.
This is the remaining M4 plan; the complete event/projection milestone has not
yet been implemented.
