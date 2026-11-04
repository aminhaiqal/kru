import type { Store } from '../store';
import { processStartIdentity } from '../rpc/process-record';
import { randomUUID } from 'node:crypto';
import { hostIdentity } from '../rpc/process-inspection';
export interface LockRow { pid: number; start_identity: string; heartbeat_at: string; status_json: string; epoch?:string }
export function lockOwnerAlive(row: LockRow): boolean {
  try { process.kill(row.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; }
  const identity = processStartIdentity(row.pid);
  // If identity cannot be inspected, a live PID is not safe to take over.
  return identity === null || identity === row.start_identity;
}
export class DaemonLock {
  private identity: string | undefined;
  epoch='';
  constructor(private readonly store: Store) {}
  acquire(): void {
    const identity = processStartIdentity(process.pid);
    if (!identity) throw new Error('Cannot determine process start identity; daemon ownership cannot be established');
    const epoch=randomUUID();
    this.store.write(() => {
      const existing = this.read();
      if(existing?.epoch){
        const host=this.store.db.query<{host_id:string},[string]>('SELECT host_id FROM boot_runs WHERE epoch=?').get(existing.epoch)?.host_id;
        if(host&&host!==hostIdentity())throw new Error('Cannot verify daemon ownership from another host/namespace');
      }
      if (existing && lockOwnerAlive(existing)) throw new Error(`A Kru daemon already owns this database (pid ${existing.pid})`);
      this.store.db.query(`INSERT INTO daemon_lock (id, pid, start_identity, heartbeat_at, status_json,epoch) VALUES (1, ?, ?, ?, '{}',?)
        ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, start_identity = excluded.start_identity,
        heartbeat_at = excluded.heartbeat_at, status_json = '{}',epoch=excluded.epoch`).run(process.pid, identity, new Date().toISOString(),epoch);
    });
    this.identity = identity;
    this.epoch=epoch;
  }
  assertOwner(ready=false):void {
    const row=this.read();
    if(!this.identity||row?.pid!==process.pid||row.start_identity!==this.identity||row.epoch!==this.epoch)throw new Error('Daemon ownership/epoch was lost');
    if(ready&&this.store.db.query<{phase:string},[string]>('SELECT phase FROM boot_runs WHERE epoch=?').get(this.epoch)?.phase!=='ready')throw new Error('Recovery barrier is closed');
  }
  read(): LockRow | null { return this.store.db.query<LockRow, []>('SELECT * FROM daemon_lock WHERE id = 1').get(); }
  heartbeat(): void {
    const result = this.store.write(() => this.store.db.query(
      'UPDATE daemon_lock SET heartbeat_at = ? WHERE id = 1 AND pid = ? AND start_identity = ? AND epoch=?')
      .run(new Date().toISOString(), process.pid, this.identity ?? '',this.epoch));
    if (result.changes !== 1) throw new Error('Daemon ownership was lost');
  }
  updateStatus(json: string): void {
    const result = this.store.write(() => this.store.db.query(
      'UPDATE daemon_lock SET status_json = ? WHERE id = 1 AND pid = ? AND start_identity = ? AND epoch=?')
      .run(json, process.pid, this.identity ?? '',this.epoch));
    if (result.changes !== 1) throw new Error('Daemon ownership was lost');
  }
  release(): void {
    if (!this.identity) return;
    this.store.write(() => this.store.db.query('DELETE FROM daemon_lock WHERE id = 1 AND pid = ? AND start_identity = ? AND epoch=?').run(process.pid, this.identity!,this.epoch));
    this.identity = undefined;
  }
}
