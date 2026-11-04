import type { Store } from '../store';
import { processStartIdentity } from '../rpc/process-record';
export interface LockRow { pid: number; start_identity: string; heartbeat_at: string; status_json: string }
export function lockOwnerAlive(row: LockRow): boolean {
  try { process.kill(row.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; }
  const identity = processStartIdentity(row.pid);
  // If identity cannot be inspected, a live PID is not safe to take over.
  return identity === null || identity === row.start_identity;
}
export class DaemonLock {
  private identity: string | undefined;
  constructor(private readonly store: Store) {}
  acquire(): void {
    const identity = processStartIdentity(process.pid);
    if (!identity) throw new Error('Cannot determine process start identity; daemon ownership cannot be established');
    this.store.write(() => {
      const existing = this.read();
      if (existing && lockOwnerAlive(existing)) throw new Error(`A Kru daemon already owns this database (pid ${existing.pid})`);
      this.store.db.query(`INSERT INTO daemon_lock (id, pid, start_identity, heartbeat_at, status_json) VALUES (1, ?, ?, ?, '{}')
        ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, start_identity = excluded.start_identity,
        heartbeat_at = excluded.heartbeat_at, status_json = '{}'`).run(process.pid, identity, new Date().toISOString());
    });
    this.identity = identity;
  }
  read(): LockRow | null { return this.store.db.query<LockRow, []>('SELECT * FROM daemon_lock WHERE id = 1').get(); }
  heartbeat(): void {
    const result = this.store.write(() => this.store.db.query(
      'UPDATE daemon_lock SET heartbeat_at = ? WHERE id = 1 AND pid = ? AND start_identity = ?')
      .run(new Date().toISOString(), process.pid, this.identity ?? ''));
    if (result.changes !== 1) throw new Error('Daemon ownership was lost');
  }
  updateStatus(json: string): void {
    const result = this.store.write(() => this.store.db.query(
      'UPDATE daemon_lock SET status_json = ? WHERE id = 1 AND pid = ? AND start_identity = ?')
      .run(json, process.pid, this.identity ?? ''));
    if (result.changes !== 1) throw new Error('Daemon ownership was lost');
  }
  release(): void {
    if (!this.identity) return;
    this.store.write(() => this.store.db.query('DELETE FROM daemon_lock WHERE id = 1 AND pid = ? AND start_identity = ?').run(process.pid, this.identity!));
    this.identity = undefined;
  }
}
