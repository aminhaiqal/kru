import type { Store } from '../store';
import type { DaemonLock } from '../daemon/lock';
import { hostIdentity } from '../rpc/process-inspection';
import { inspectExecutions } from './inspect';
import { recoverExecution } from './recover-execution';
import { containRuntimes, type ContainmentOps } from './containment';
import type { BootPhase } from './types';
import { storedError } from '../store/errors';
export interface RecoveryOptions { graceMs?:number; ops?:ContainmentOps; checkpoint?:(name:string,id?:string)=>Promise<void>|void }
export class BootRecovery {
  readonly hostId=hostIdentity();
  constructor(private readonly store:Store,private readonly lock:DaemonLock,private readonly options:RecoveryOptions={}){}
  private phase(phase:BootPhase,error?:unknown):void {
    this.store.write(()=>{
      this.lock.assertOwner();
      this.store.db.query('UPDATE boot_runs SET phase=?,error=?,updated_at=? WHERE epoch=?').run(phase,error===undefined?null:storedError(error instanceof Error?error.message:String(error))??null,new Date().toISOString(),this.lock.epoch);
    });
  }
  async run():Promise<void> {
    const cutoff=this.store.db.query<{n:number},[]>('SELECT coalesce(max(seq),0) AS n FROM deliveries').get()!.n;
    const owner=this.lock.read()!,at=new Date().toISOString();
    this.store.write(()=>{this.lock.assertOwner();this.store.db.query('INSERT INTO boot_runs(epoch,database_id,host_id,pid,start_identity,phase,cutoff_seq,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(this.lock.epoch,this.store.databaseId,this.hostId,process.pid,owner.start_identity,'inspect',cutoff,at,at);});
    try{
      const ids=inspectExecutions(this.store,cutoff);await this.options.checkpoint?.('after-inspect');
      this.phase('reconcile');
      for(const id of ids){recoverExecution(this.store,this.lock,id);await this.options.checkpoint?.('after-recovery-commit',id);}
      this.phase('contain');await containRuntimes(this.store,this.lock,this.hostId,this.options);
      // No turn can have used an unactivated setup. Contained runtimes cannot
      // later activate their candidates; retain identity/evidence as abandoned.
      this.store.write(()=>this.store.db.query("UPDATE session_setup_attempts SET state='abandoned',error='Boot contained the old setup runtime; unused native candidate is abandoned and cannot be reused',updated_at=? WHERE state IN ('creating','candidate','setup_unknown','cleanup_pending') AND (owner_epoch IS NULL OR owner_epoch<>?)").run(new Date().toISOString(),this.lock.epoch));
      this.phase('verify');
      if(inspectExecutions(this.store,cutoff).length)throw new Error('Recovery invariant: old executions remain active');
      if(this.store.db.query("SELECT 1 FROM cleanup_journal WHERE state<>'complete'").get())throw new Error('Recovery invariant: unresolved process cleanup');
      await this.options.checkpoint?.('before-ready');this.phase('ready');
    }catch(error){this.phase('blocked',error);throw error;}
  }
}
