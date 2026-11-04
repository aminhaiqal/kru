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

export interface DaemonOptions extends SchedulerOptions { pollMs?: number; heartbeatMs?: number; shutdownGraceMs?: number }
export class Daemon {
  readonly scheduler: Scheduler;
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private readonly lock: DaemonLock;
  private readonly mailbox: SqliteMailbox;
  private readonly ledger: UsageLedger;
  private readonly history: SqliteTurnHistory;
  private poll: ReturnType<typeof setInterval> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
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
    this.lock = new DaemonLock(store); this.mailbox = new SqliteMailbox(store);
    this.ledger = options.ledger ?? new SqliteUsageLedger(store);
    this.history = new SqliteTurnHistory(store, {
      ...(options.now ? { now: options.now } : {}),
      onError: error => { this.failure = error; void this.stop(0); },
    });
    this.scheduler = new Scheduler(this.mailbox, new AgentRegistry(store), new SqliteSessions(store),
      factory ?? (agent => createProvider(agent.provider)), {
        ...options, ledger: this.ledger, turns: options.turns ?? this.history,
        onState: () => { options.onState?.(); this.queueSnapshot(); },
        onError: error => { this.failure = error; options.onError?.(error); void this.stop(0); },
      });
  }
  start(): void {
    if (this.started || this.stopping) throw new Error('Daemon has already started or stopped');
    this.lock.acquire(); this.started = true;
    try {
      this.store.atomic(() => { this.history.recover(); this.ledger.recover(); this.mailbox.recoverInterrupted(); });
      this.version = this.dataVersion();
      this.scheduler.start(); this.writeSnapshot();
      this.poll = setInterval(() => {
        try {
          // Retain the sample taken before refresh: concurrent commits are seen next tick.
          const version = this.dataVersion();
          if (version !== this.version) { this.version = version; this.scheduler.refresh(); }
          this.scheduler.tick();
        } catch (error) { this.failure = error; void this.stop(0); }
      }, this.options.pollMs ?? 100);
      this.heartbeat = setInterval(() => {
        try { this.lock.heartbeat(); } catch (error) { this.failure = error; void this.stop(0); }
      }, this.options.heartbeatMs ?? 10_000);
    } catch (error) { this.failure = error; void this.stop(0); throw error; }
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
    this.stopPromise = this.scheduler.stop(graceMs).catch(error => { this.failure ??= error; }).finally(() => {
      try { this.lock.release(); } catch (error) { this.failure ??= error; }
      this.resolveClosed();
    });
    return this.stopPromise;
  }
  async forceStop(): Promise<void> {
    const stopping = this.stop(0);
    await this.scheduler.forceStop(); await stopping;
  }
}
