import type { Store } from '../store';
import { verifyReplay } from '../store/replay';
/** Reject disagreement before changing any domain outcome. Queue enqueues remain safe. */
export function inspectExecutions(store:Store,cutoff:number):string[] {
  const replay=verifyReplay(store);
  if(!replay.matches)throw new Error(`Recovery invariant: projection drift in ${replay.differences.join(', ')}`);
  const orphan=store.db.query(`SELECT batch_id FROM active_lanes a WHERE NOT EXISTS
    (SELECT 1 FROM deliveries d WHERE d.batch_id=a.batch_id AND d.recipient_id=a.agent_id AND coalesce(d.lane_id,'')=a.lane_key AND d.status IN ('starting','running'))`).get();
  if(orphan)throw new Error(`Recovery invariant: orphan lane reservation ${JSON.stringify(orphan)}`);
  const missing=store.db.query(`SELECT id FROM deliveries d WHERE status IN ('starting','running') AND batch_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM active_lanes a WHERE a.batch_id=d.batch_id AND a.agent_id=d.recipient_id AND a.lane_key=coalesce(d.lane_id,''))`).get();
  if(missing)throw new Error(`Recovery invariant: active delivery has no matching lane ${JSON.stringify(missing)}`);
  const turn=store.db.query(`SELECT id FROM turns t WHERE status IN ('starting','running') AND NOT EXISTS
    (SELECT 1 FROM deliveries d WHERE d.batch_id=t.id AND d.status IN ('starting','running'))`).get();
  if(turn)throw new Error(`Recovery invariant: abandoned turn has no active batch ${JSON.stringify(turn)}`);
  return store.db.query<{id:string},[number]>("SELECT coalesce(batch_id,id) AS id FROM deliveries WHERE status IN ('starting','running') AND seq<=? GROUP BY coalesce(batch_id,id) ORDER BY min(seq)").all(cutoff).map(r=>r.id);
}
