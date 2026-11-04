import type { Store } from '../store';
import { AgentRegistry } from '../agents';
import { SqliteMailbox } from '../mailbox';
import { Scheduler, type SchedulerOptions, type ProviderFactory } from '../scheduler';
import { createProvider } from '../providers/registry';
import { DaemonLock } from './lock';
import { SqliteUsageLedger } from '../usage/sqlite';
import type { UsageLedger } from '../usage/ledger';
import { SqliteSessions } from './sessions';
import { SqliteTurnHistory } from '../turns/recorder';
import { ToolRouter, SqliteToolState } from '../tools';
import { SqliteHistory } from '../threads/history';
import { BootRecovery, type RecoveryOptions } from '../boot/recovery';
import { randomUUID } from 'node:crypto';
import type { ProviderClient } from '../providers/protocol';
import type { Batch } from '../mailbox';
import { basename } from 'node:path';

export interface DaemonOptions extends SchedulerOptions { pollMs?: number; heartbeatMs?: number; shutdownGraceMs?: number; recovery?:RecoveryOptions }
export class Daemon {
  readonly scheduler: Scheduler;
  readonly closed: Promise<void>;
  readonly ready:Promise<void>;
  private readyResolve!:()=>void;
  private readyReject!:(error:unknown)=>void;
  private bootTask:Promise<void>|undefined;
  private readonly recovery:BootRecovery;
  private resolveClosed!: () => void;
  private readonly lock: DaemonLock;
  private readonly mailbox: SqliteMailbox;
  private readonly ledger: UsageLedger;
  private readonly history: SqliteTurnHistory;
  private poll: ReturnType<typeof setInterval> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private usageTimer:ReturnType<typeof setInterval>|undefined;
  private version = 0;
  private stopPromise: Promise<void> | undefined;
  private started = false;
  private stopping = false;
  private snapshotQueued = false;
  private lastSnapshot: string | undefined;
  failure: unknown;
  constructor(private readonly store: Store, private readonly options: DaemonOptions = {}, factory?: ProviderFactory) {
    const heartbeatMs = options.heartbeatMs ?? 10_000;
    if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > 2_147_483_647) throw new Error('Invalid heartbeat interval');
    const pollMs = options.pollMs ?? 100;
    if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 2_147_483_647) throw new Error('Invalid poll interval');
    if (options.shutdownGraceMs !== undefined && (!Number.isSafeInteger(options.shutdownGraceMs) || options.shutdownGraceMs < 0 || options.shutdownGraceMs > 2_147_483_647)) throw new Error('Invalid shutdown grace');
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});void this.ready.catch(()=>{});
    this.lock = new DaemonLock(store); this.mailbox = new SqliteMailbox(store);
    this.recovery=new BootRecovery(store,this.lock,options.recovery);
    this.ledger = options.ledger ?? new SqliteUsageLedger(store);
    this.history = new SqliteTurnHistory(store, {
      ...(options.now ? { now: options.now } : {}),
      onError: error => { this.failure = error; void this.stop(0); },
    });
    const agents = new AgentRegistry(store);
    const tools = options.tools ?? new ToolRouter(this.mailbox, agents, new SqliteToolState(store), {
      history: new SqliteHistory(store),
      ...(options.maxHops === undefined ? {} : { maxHops: options.maxHops }),
    });
    const runtimeIds=new WeakMap<ProviderClient,string>();
    const guard=()=>this.lock.assertOwner(true);
    const guardExecution=(batch:Batch)=>{
      guard();
      const row=store.db.query<{epoch:string;generation_id:string|null;native_thread_id:string|null},[string]>('SELECT * FROM execution_owners WHERE execution_id=?').get(batch.id);
      if(row?.epoch!==this.lock.epoch||!store.db.query('SELECT 1 FROM active_lanes WHERE batch_id=?').get(batch.id))throw new Error('Stale execution epoch or released batch');
      if(row.generation_id&&!store.db.query('SELECT 1 FROM provider_sessions WHERE generation_id=? AND native_thread_id=? AND active=1').get(row.generation_id,row.native_thread_id))throw new Error('Stale session generation');
    };
    this.scheduler = new Scheduler(this.mailbox, agents, new SqliteSessions(store),
      (agent,lane)=>{
        guard();const provider=factory?factory(agent,lane):createProvider(agent.provider);
        const scope={databaseId:store.databaseId,hostId:this.recovery.hostId,ownerEpoch:this.lock.epoch,ownerStartIdentity:this.lock.read()!.start_identity,runtimeId:randomUUID(),directory:store.processDirectory,
          onRecord:(path:string,record:unknown)=>store.write(()=>store.db.query(`INSERT INTO cleanup_journal VALUES(?,?,?,?,?,?,?) ON CONFLICT(runtime_id) DO UPDATE SET record_json=excluded.record_json,state='active',updated_at=excluded.updated_at`)
            .run(basename(path),this.lock.epoch,path,JSON.stringify(record),'active',null,new Date().toISOString())),
          onContained:(path:string)=>store.write(()=>store.db.query("UPDATE cleanup_journal SET state='complete',detail='normal shutdown confirmed',updated_at=? WHERE record_path=?").run(new Date().toISOString(),path)),
        };
        runtimeIds.set(provider,provider.setProcessScope?.(scope)??scope.runtimeId);return provider;
      }, {
        ...options, tools, ledger: this.ledger, turns: options.turns ?? this.history,
        guard,guardExecution,
        onClaim:(batch,provider)=>{store.write(()=>store.db.query('INSERT INTO execution_owners VALUES(?,?,?,NULL,NULL)').run(batch.id,this.lock.epoch,runtimeIds.get(provider)!));options.onClaim?.(batch,provider);},
        onBound:(batch,threadId)=>{store.write(()=>store.db.query(`UPDATE execution_owners SET generation_id=(SELECT generation_id FROM provider_sessions WHERE agent_id=? AND lane_key=? AND active=1),native_thread_id=? WHERE execution_id=?`).run(batch.agentId,batch.laneId??'',threadId,batch.id));options.onBound?.(batch,threadId);},
        onState: () => { options.onState?.(); this.queueSnapshot(); },
        onError: error => { this.failure = error; options.onError?.(error); void this.stop(0); },
      });
  }
  start(): void {
    if (this.started || this.stopping) throw new Error('Daemon has already started or stopped');
    this.lock.acquire(); this.started = true;
    this.store.setWriteFence(()=>this.lock.assertOwner());
    this.bootTask=this.recovery.run();
    void this.bootTask.then(()=>{
      if(this.stopping){this.readyReject(new Error('Daemon stopped during recovery'));return;}
      this.version = this.dataVersion();
      this.scheduler.start(); this.writeSnapshot();
      this.readyResolve();
      this.usageTimer=setInterval(()=>{try{this.ledger.flush?.();}catch(error){this.failure=error;void this.stop(0);}},2000);
      this.poll = setInterval(() => {
        try {
          this.lock.assertOwner(true);
          // Retain the sample taken before refresh: concurrent commits are seen next tick.
          const version = this.dataVersion();
          if (version !== this.version) { this.version = version; this.scheduler.refresh(); }
          this.scheduler.tick();
        } catch (error) { this.failure = error; void this.stop(0); }
      }, this.options.pollMs ?? 100);
      this.heartbeat = setInterval(() => {
        try { this.lock.heartbeat(); this.mailbox.pruneIdempotencyKeys(); }
        catch (error) { this.failure = error; void this.stop(0); }
      }, this.options.heartbeatMs ?? 10_000);
    }).catch(error=>{this.failure=error;this.readyReject(error);void this.stop(0);});
  }
  private dataVersion(): number { return this.store.db.query<{ data_version: number }, []>('PRAGMA data_version').get()!.data_version; }
  private queueSnapshot(): void {
    if (this.snapshotQueued || !this.started || this.stopping) return;
    this.snapshotQueued = true;
    queueMicrotask(() => {
      this.snapshotQueued = false;
      if (this.stopping) return;
      try { this.writeSnapshot(); } catch (error) { this.failure = error; void this.stop(0); }
    });
  }
  private writeSnapshot(): void {
    const snapshot = JSON.stringify({ budgetTimezone: this.scheduler.budgetTimezone,
      lanes: this.scheduler.status(), activeTurns: this.scheduler.activeTurns });
    if (snapshot === this.lastSnapshot) return;
    this.lock.updateStatus(snapshot);
    this.lastSnapshot = snapshot;
  }
  stop(graceMs = this.options.shutdownGraceMs ?? 5_000): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true; clearInterval(this.poll); clearInterval(this.heartbeat);
    clearInterval(this.usageTimer);
    this.stopPromise = Promise.resolve(this.bootTask).catch(()=>{}).then(()=>this.scheduler.stop(graceMs)).catch(error => { this.failure ??= error; }).finally(() => {
      try { this.lock.release(); } catch (error) { this.failure ??= error; }
      this.store.setWriteFence();
      this.resolveClosed();
    });
    return this.stopPromise;
  }
  async forceStop(): Promise<void> {
    const stopping = this.stop(0);
    await this.scheduler.forceStop(); await stopping;
  }
}
