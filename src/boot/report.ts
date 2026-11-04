import type { Store } from '../store';
import type { RecoveryRow, RecoveryUsageRow, QuarantineRow } from './types';
export function recoveryReport(store:Store) {
  const boot=store.db.query<{epoch:string;phase:string;error:string|null;started_at:string;updated_at:string},[]>('SELECT epoch,phase,error,started_at,updated_at FROM boot_runs ORDER BY rowid DESC LIMIT 1').get();
  return {boot,barrierOpen:boot?.phase==='ready',
    executions:store.db.query<RecoveryRow,[]>('SELECT * FROM recoveries ORDER BY recovered_at,execution_id').all(),
    quarantinedSessions:store.db.query<QuarantineRow,[]>('SELECT * FROM session_quarantines ORDER BY quarantined_at,generation_id').all(),
    cleanup:store.db.query("SELECT runtime_id,owner_epoch,record_path,state,detail,CASE WHEN json_valid(record_json) THEN json_extract(record_json,'$.scope.runtimeId') END AS execution_runtime_id FROM cleanup_journal ORDER BY runtime_id").all(),
    usageGaps:store.db.query<RecoveryUsageRow,[]>('SELECT * FROM recovery_usage ORDER BY recorded_at,execution_id').all(),
    queued:store.db.query('SELECT id,seq,recipient_id,lane_id FROM deliveries WHERE status=\'queued\' ORDER BY seq').all()};
}
