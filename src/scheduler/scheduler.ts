import type { Agent } from '../agents';
import type { Batch, LaneHead, Mailbox } from '../mailbox';
import type { ProviderClient, TokenUsage } from '../providers/protocol';
import { sessionConfigHash, bindSession } from './session';
import type { AgentSource, ProviderFactory, SessionStore } from './ports';
import { batchPrompt } from './batch';
import { holdReason, type HoldReason } from './holds';
import { TurnSlots } from './slots';
import { runScheduledTurn } from './runner';
import { abortable } from './abortable';
import { BudgetCalendar } from './budget-day';
import { MemoryUsageLedger, type UsageLedger } from '../usage/ledger';
import { zeroTokens } from '../providers/token-usage';
import { nanoUsd } from '../usage/pricing';
import type { TurnHistory } from '../turns/ports';
import type { AgentTools, ToolContext } from '../tools/ports';
import { TurnAnswer } from '../tools/delivery-content';
import { storedError } from '../store/errors';

export interface LaneStatus {
  agentId: string; laneId: string | null; state: 'held' | 'starting' | 'running';
  reason?: HoldReason; error?: string; batchId?: string; batchSize?: number; turnId?: string;
  usedTokens: number; dailyTokens?: number; usedUsd?: number; dailyUsd?: number; budgetDetail?: string;
}
interface Runtime {
  active?: ToolContext;
  provider: ProviderClient; configHash: string; ready: boolean; starting: boolean; retryAt: number;
  error?: string; threadId?: string;
}
export interface SchedulerOptions {
  tools?: AgentTools; maxHops?: number;
  turns?: TurnHistory;
  budgetTimezone?: string; ledger?: UsageLedger;
  maxTurns?: number; idleTimeoutMs?: number; startTimeoutMs?: number; startGraceMs?: number;
  providerRetryMs?: number; now?: () => number;
  onState?: () => void; onError?: (error: unknown) => void;
  /** Test seam for the historical lost-wakeup gap, after turn completion but before flag release. */
  beforeRelease?: (agentId: string, laneId: string | null) => void;
}
const keyOf = (agentId: string, laneId: string | null) => JSON.stringify([agentId, laneId]);
const errorText = (e: unknown) => storedError(e instanceof Error ? e.message : String(e))!;

export class Scheduler {
  private readonly scheduled = new Set<string>();
  private readonly draining = new Set<string>();
  private readonly runtimes = new Map<string, Runtime>();
  private readonly lanes = new Map<string, LaneHead>();
  private readonly states = new Map<string, LaneStatus>();
  private readonly controllers = new Set<AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly ledger: UsageLedger;
  private readonly slots: TurnSlots;
  private readonly now: () => number;
  private day: string;
  private readonly calendar: BudgetCalendar;
  readonly budgetTimezone: string;
  private pumping = false;
  private stopped = false;
  private started = false;
  private readonly setupAbort = new AbortController();
  private unsubscribe: (() => void) | undefined;
  private unsubscribeUsage: (() => void) | undefined;
  private unsubscribeAgents: (() => void) | undefined;

  constructor(private readonly mailbox: Mailbox, private readonly agents: AgentSource,
    private readonly sessions: SessionStore, private readonly createProvider: ProviderFactory,
    private readonly options: SchedulerOptions = {}) {
    this.slots = new TurnSlots(options.maxTurns);
    this.now = options.now ?? Date.now;
    this.ledger = options.ledger ?? new MemoryUsageLedger();
    this.calendar = new BudgetCalendar(options.budgetTimezone);
    this.budgetTimezone = this.calendar.timeZone;
    this.day = this.today();
    for (const value of [options.idleTimeoutMs, options.startTimeoutMs, options.startGraceMs, options.providerRetryMs]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)) throw new Error('Scheduler deadlines must be positive timer durations');
    }
  }
  start(): void {
    if (this.started || this.stopped) throw new Error('Scheduler has already started or stopped');
    this.started = true;
    const refresh = () => { try { this.refresh(); } catch (error) { this.fail(error); } };
    this.unsubscribe = this.mailbox.onChange(refresh);
    this.unsubscribeAgents = this.agents.onChange(refresh);
    this.unsubscribeUsage = this.ledger.onChange(refresh);
    this.refresh();
  }
  /** Also called on external commits and timer/hold changes. */
  refresh(): void {
    if (this.stopped) return;
    this.resetDay();
    const current = this.mailbox.listLanes();
    const visible = new Set<string>();
    for (const lane of current) {
      const key = keyOf(lane.agentId, lane.laneId); visible.add(key); this.lanes.set(key, lane);
      if (lane.head && !this.draining.has(key)) this.scheduled.add(key);
      if (!lane.head && !this.draining.has(key) && !this.mailbox.laneBusy(lane.agentId, lane.laneId)) this.states.delete(key);
    }
    for (const key of this.lanes.keys()) {
      if (!visible.has(key) && !this.draining.has(key)) { this.lanes.delete(key); this.states.delete(key); this.scheduled.delete(key); }
    }
    this.pumpSoon(); this.changed();
  }
  scheduleLane(agentId: string, laneId: string | null): void {
    if (this.stopped) return;
    const key = keyOf(agentId, laneId);
    this.lanes.set(key, { agentId, laneId, head: this.mailbox.listQueue(agentId, laneId).find(d => d.status === 'queued') ?? null });
    this.scheduled.add(key); this.pumpSoon();
  }
  /** Timer work does not scan queue contents unless a hold may have cleared. */
  tick(): void {
    if (this.stopped) return;
    if (this.resetDay()) { this.refresh(); return; }
    for (const [key, state] of this.states) {
      const runtime = this.runtimes.get(key);
      if (state.reason === 'provider-not-ready' && !runtime?.starting && (!runtime || this.now() >= runtime.retryAt)) this.scheduled.add(key);
    }
    if (this.scheduled.size) this.pumpSoon();
  }
  status(): LaneStatus[] { return [...this.states.values()].sort((a, b) => keyOf(a.agentId, a.laneId).localeCompare(keyOf(b.agentId, b.laneId))).map(s => ({ ...s })); }
  get activeTurns(): number { return this.slots.active; }

  private today(): string { return this.calendar.day(this.now()); }
  private resetDay(): boolean {
    const day = this.today();
    if (this.day === day) return false;
    this.day = day;
    for (const state of this.states.values()) {
      const value = this.ledger.totals(state.agentId, this.calendar, this.now());
      state.usedTokens = value.tokens; state.usedUsd = value.nanoUsd / 1e9;
    }
    return true;
  }
  private used(agentId: string): number { return this.ledger.totals(agentId, this.calendar, this.now()).tokens; }
  private account(batch: Batch, value: TokenUsage): void {
    this.resetDay(); this.ledger.observe(batch.id, value);
    const total = this.ledger.totals(batch.agentId, this.calendar, this.now());
    for (const state of this.states.values()) if (state.agentId === batch.agentId) {
      state.usedTokens = total.tokens; state.usedUsd = total.nanoUsd / 1e9;
    }
    this.changed();
  }
  private changed(): void { this.options.onState?.(); }
  private fail(error: unknown): void {
    this.stopped = true; this.unsubscribe?.(); this.unsubscribeAgents?.(); this.unsubscribeUsage?.(); this.scheduled.clear();
    if (this.options.onError) this.options.onError(error);
    else process.emitWarning(`Scheduler stopped: ${errorText(error)}`);
  }
  private pumpSoon(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    queueMicrotask(() => {
      this.pumping = false;
      if (this.stopped) return;
      try { this.pump(); } catch (error) { this.fail(error); }
    });
  }
  private runtime(key: string, agent: Agent, laneId: string | null): Runtime | undefined {
    const hash = sessionConfigHash(agent, this.options.tools);
    const old = this.runtimes.get(key);
    if (old && old.configHash === hash) {
      if (!old.ready && !old.starting && this.now() >= old.retryAt) this.beginProvider(old, key);
      return old;
    }
    // No turn is draining here, so retiring a changed configuration is safe.
    if (old) {
      this.runtimes.delete(key);
      this.track(old.provider.stop().catch(error => this.fail(error)));
    }
    const provider = this.createProvider(agent, laneId);
    const runtime: Runtime = { provider, configHash: hash, ready: false, starting: false, retryAt: 0 };
    this.runtimes.set(key, runtime);
    provider.on('exit', error => {
      runtime.ready = false; delete runtime.threadId; runtime.error = errorText(error);
      runtime.retryAt = this.now() + (this.options.providerRetryMs ?? 1_000);
      if (!this.stopped) this.scheduleLane(agent.id, laneId);
    });
    // Bind calls to this provider view's confirmed active turn, never a model-supplied sender.
    provider.on('request', request => {
      if (request.signal.aborted) return;
      if (request.method === 'approval/request') provider.respond(request.id, { decision: 'decline' });
      else {
        const context = runtime.active;
        if (!this.options.tools || !context || this.stopped || context.threadId !== request.params.threadId || context.turnId !== request.params.turnId) {
          provider.respondError(request.id, { code: -32602, message: 'No matching active Kru tool turn' }); return;
        }
        let result;
        try { result = this.options.tools.handle(context, request.params); }
        catch (error) {
          if (!request.signal.aborted) provider.respondError(request.id, { code: -32603, message: 'Kru tool transaction failed' });
          this.fail(error); return;
        }
        if (!request.signal.aborted) provider.respond(request.id, result);
      }
    });
    this.beginProvider(runtime, key);
    return runtime;
  }
  private beginProvider(runtime: Runtime, key: string): void {
    if (this.stopped || runtime.starting) return;
    runtime.starting = true;
    const task = abortable(Promise.resolve().then(() => runtime.provider.start()).then(async () => {
      if (this.stopped) { await runtime.provider.forceStop(); return; }
      runtime.ready = true; delete runtime.error;
    }), this.setupAbort.signal, this.options.startTimeoutMs ?? 30_000).catch(async error => {
      runtime.ready = false; runtime.error = errorText(error);
      runtime.retryAt = this.now() + (this.options.providerRetryMs ?? 1_000);
      await runtime.provider.stop();
    }).finally(() => {
      runtime.starting = false;
      if (!this.stopped && this.runtimes.get(key) === runtime) { this.scheduled.add(key); this.pumpSoon(); }
    });
    this.track(task);
  }
  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(error => this.fail(error));
  }
  private pump(): void {
    const keys = [...this.scheduled]; this.scheduled.clear();
    const candidates = keys.filter(k => !this.draining.has(k)).map(key => {
      const lane = this.lanes.get(key)!;
      const head = this.mailbox.listQueue(lane.agentId, lane.laneId).find(d => d.status === 'queued') ?? null;
      return { key, lane: { ...lane, head } };
    }).filter(c => c.lane.head).sort((a, b) =>
      Number(a.lane.head!.sender.kind !== 'user') - Number(b.lane.head!.sender.kind !== 'user') || a.lane.head!.seq - b.lane.head!.seq);
    for (const { key, lane } of candidates) {
      const agent = this.agents.get(lane.agentId);
      if (!agent) continue;
      let runtime: Runtime | undefined;
      let error: string | undefined;
      if (!agent.config.paused) {
        try { runtime = this.runtime(key, agent, lane.laneId); }
        catch (e) { error = errorText(e); }
      }
      const total = this.ledger.totals(agent.id, this.calendar, this.now());
      const dollars = agent.config.dailyUsd as number | undefined;
      const model = String(agent.config.model ?? (agent.provider === 'fake' ? 'fake' : 'unknown'));
      const priced = this.ledger.isPriced(agent.provider, model, new Date(this.now()).toISOString());
      const budgetDetail = total.unknownTokens && agent.config.dailyTokens !== undefined ? 'unknown usage'
        : dollars !== undefined && (total.unknownUsd || !priced) ? 'unknown or unpriced USD usage'
        : dollars !== undefined && total.nanoUsd >= nanoUsd(dollars) ? 'USD limit' : 'token limit';
      const budgetBlocked = (agent.config.dailyTokens !== undefined && total.unknownTokens)
        || (dollars !== undefined && (total.unknownUsd || !priced || total.nanoUsd >= nanoUsd(dollars)));
      const reason = holdReason({ paused: agent.config.paused === true, ready: runtime?.ready ?? false,
        busy: this.mailbox.laneBusy(agent.id, lane.laneId), used: this.used(agent.id),
        limit: agent.config.dailyTokens as number | undefined, budgetBlocked, slots: this.slots.available });
      if (reason) {
        this.states.set(key, { agentId: agent.id, laneId: lane.laneId, state: 'held', reason, usedUsd: total.nanoUsd / 1e9, budgetDetail,
          ...(dollars !== undefined ? { dailyUsd: dollars } : {}),
          usedTokens: this.used(agent.id), ...(agent.config.dailyTokens !== undefined ? { dailyTokens: Number(agent.config.dailyTokens) } : {}),
          ...((error ?? runtime?.error) ? { error: error ?? runtime!.error! } : {}) });
        continue;
      }
      const releaseSlot = this.slots.acquire()!;
      this.draining.add(key);
      let batch: Batch | null;
      try { batch = this.mailbox.claimBatch(agent.id, lane.laneId); }
      catch (e) { this.draining.delete(key); releaseSlot(); throw e; }
      if (!batch) { this.draining.delete(key); releaseSlot(); continue; }
      this.ledger.begin(batch, agent.provider, model, new Date(this.now()).toISOString());
      const controller = new AbortController(); this.controllers.add(controller);
      this.states.set(key, { agentId: agent.id, laneId: lane.laneId, state: 'starting', batchId: batch.id,
        batchSize: batch.deliveries.length, usedUsd: total.nanoUsd / 1e9, ...(dollars !== undefined ? { dailyUsd: dollars } : {}), usedTokens: this.used(agent.id),
        ...(agent.config.dailyTokens !== undefined ? { dailyTokens: Number(agent.config.dailyTokens) } : {}) });
      this.track(this.execute(runtime!, agent, batch, controller).catch(e => this.fail(e)).finally(() => {
        this.options.beforeRelease?.(agent.id, lane.laneId);
        this.controllers.delete(controller); releaseSlot(); this.draining.delete(key); this.states.delete(key);
        // Work arriving during the old draining flag must be checked after release.
        if (!this.stopped) this.refresh();
        this.changed();
      }));
    }
    this.changed();
  }
  private async execute(runtime: Runtime, agent: Agent, batch: Batch, controller: AbortController): Promise<void> {
    const prompt = this.options.tools?.render(batch) ?? batchPrompt(batch);
    if (Buffer.byteLength(prompt) > 32 * 1024) {
      this.ledger.abandon(batch.id, () => this.mailbox.finishBatch(batch.id, 'failed', 'Message exceeds the 32 KB turn input limit; send smaller messages'));
      return;
    }
    try {
      runtime.threadId ??= await abortable(bindSession(runtime.provider, agent, batch.laneId, this.sessions, controller.signal, this.options.tools),
        controller.signal, this.options.startTimeoutMs ?? 30_000);
    } catch (error) {
      // No turn/start was sent: preserve order and hold until the provider recovers.
      controller.abort();
      runtime.ready = false; runtime.error = errorText(error);
      runtime.retryAt = this.now() + (this.options.providerRetryMs ?? 1_000);
      await runtime.provider.stop(); runtime.error = errorText(error); delete runtime.threadId;
      this.ledger.abandon(batch.id, () => this.mailbox.restoreBatch(batch.id)); return;
    }
    if (this.stopped || controller.signal.aborted) { this.ledger.abandon(batch.id, () => this.mailbox.restoreBatch(batch.id)); return; }
    const recording = this.options.turns?.prepare(batch, agent, runtime.threadId,
      this.sessions.get(agent.id, batch.laneId, agent.provider)?.promptHash ?? 'unknown');
    const answer = new TurnAnswer();
    let context: ToolContext | undefined;
    const outcome = await runScheduledTurn(runtime.provider, runtime.threadId, prompt, {
      signal: controller.signal,
      onSubmitting: () => this.ledger.submitted(batch.id),
      ...(this.options.idleTimeoutMs !== undefined ? { idleTimeoutMs: this.options.idleTimeoutMs } : {}),
      ...(this.options.startTimeoutMs !== undefined ? { startTimeoutMs: this.options.startTimeoutMs } : {}),
      ...(this.options.startGraceMs !== undefined ? { startGraceMs: this.options.startGraceMs } : {}),
      onStarted: turnId => {
        this.ledger.started(batch.id, runtime.threadId!, turnId, () => {
          recording?.started(turnId);
          this.mailbox.markBatchRunning(batch.id, turnId);
        });
        context = { agent, batch, threadId: runtime.threadId!, turnId };
        runtime.active = context;
        const state = this.states.get(keyOf(agent.id, batch.laneId));
        if (state) { state.state = 'running'; state.turnId = turnId; this.changed(); }
      },
      onUsage: value => this.account(batch, value),
      onNotification: notification => { recording?.observe(notification); answer.observe(notification); },
      onFinished: () => { delete runtime.active; },
    });
    if (outcome.retireSession) {
      const threadId = runtime.threadId;
      delete runtime.threadId;
      this.sessions.remove(agent.id, batch.laneId, agent.provider);
      // The adapter owns cancellation and liveness. Shared providers tombstone only this thread.
      await runtime.provider.retireThread(threadId);
    }
    if (outcome.noExecution) this.ledger.observe(batch.id, { last: zeroTokens(), total: zeroTokens() });
    this.ledger.settle(batch.id, outcome.status, !outcome.retireSession,
      () => {
        recording?.finish(outcome);
        if (context) this.options.tools?.finish(context, answer.text(), outcome.status);
        this.mailbox.finishBatch(batch.id, outcome.status, outcome.error);
      });
  }
  async stop(graceMs = 5_000): Promise<void> {
    this.stopped = true; this.setupAbort.abort(); this.unsubscribe?.(); this.unsubscribeAgents?.(); this.unsubscribeUsage?.(); this.scheduled.clear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = Promise.allSettled([...this.tasks]);
    await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs); })]);
    clearTimeout(timer);
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.runtimes.values()].map(r => r.provider.stop()));
    await Promise.allSettled([...this.tasks]);
  }
  async forceStop(): Promise<void> {
    this.stopped = true; this.setupAbort.abort(); this.unsubscribe?.(); this.unsubscribeAgents?.(); this.unsubscribeUsage?.(); this.scheduled.clear();
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.runtimes.values()].map(r => r.provider.forceStop()));
  }
}
