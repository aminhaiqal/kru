import type { Notification, ProviderClient, TokenUsage } from '../providers/protocol';

export interface TurnOutcome { status: 'completed' | 'failed' | 'interrupted'; error?: string; retireSession?: boolean; noExecution?: boolean }
export interface RunnerOptions {
  idleTimeoutMs?: number; startTimeoutMs?: number; startGraceMs?: number;
  onSubmitting?: () => void;
  signal: AbortSignal; onStarted(id: string): void; onUsage(usage: TokenUsage): void;
}
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Retains listeners through unknown start outcomes. It never retries turn/start. */
export function runScheduledTurn(provider: ProviderClient, threadId: string, text: string, options: RunnerOptions): Promise<TurnOutcome> {
  return new Promise(resolve => {
    let turnId: string | undefined, done = false;
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const commands = new Set<string>();
    const early: Notification[] = [];
    let earlyBytes = 0;
    const interrupt = () => {
      if (turnId) void provider.request('turn/interrupt', { threadId, turnId }).catch(() => {});
    };
    const finish = (outcome: TurnOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(startTimer); clearTimeout(idleTimer); clearTimeout(graceTimer);
      provider.off('notification', notification); provider.off('exit', exit); provider.off('activity', activity);
      options.signal.removeEventListener('abort', abort);
      resolve(outcome);
    };
    const uncertain = () => {
      if (done || turnId || graceTimer) return;
      clearTimeout(startTimer);
      graceTimer = setTimeout(() => finish({ status: 'interrupted', error: 'turn/start outcome unknown after grace period', retireSession: true }), options.startGraceMs ?? 300_000);
    };
    const idle = () => {
      clearTimeout(idleTimer);
      if (!commands.size && turnId) idleTimer = setTimeout(() => {
        finish({ status: 'interrupted', error: 'Turn idle timeout', retireSession: true }); interrupt();
      }, options.idleTimeoutMs ?? 120_000);
    };
    const started = (id: string) => {
      if (turnId) { if (turnId !== id) throw new Error('Provider changed the active turn id'); return; }
      turnId = id;
      clearTimeout(startTimer); clearTimeout(graceTimer);
      options.onStarted(id); idle();
      for (const event of early.splice(0)) consume(event);
    };
    const consume = (n: Notification) => {
      if (done) return;
      const id = 'turn' in n.params ? n.params.turn.id : n.params.turnId;
      if (id !== turnId) return;
      if (n.method === 'item/started' && n.params.item.type === 'commandExecution') commands.add(n.params.item.id);
      if (n.method === 'item/completed') commands.delete(n.params.item.id);
      idle();
      if (n.method === 'thread/tokenUsage/updated') options.onUsage(n.params.tokenUsage);
      if (n.method === 'turn/completed') {
        const status = n.params.turn.status;
        if (status === 'inProgress') throw new Error('Invalid completed turn status');
        finish({ status, ...(n.params.turn.error?.message ? { error: n.params.turn.error.message } : {}) });
      }
    };
    const notification = (n: Notification) => {
      if (done || n.params.threadId !== threadId) return;
      try {
        if (n.method === 'turn/started') {
          if (turnId && n.params.turn.id !== turnId) return;
          started(n.params.turn.id);
        }
        if (turnId) consume(n);
        else {
          earlyBytes += Buffer.byteLength(JSON.stringify(n));
          if (earlyBytes > 1024 * 1024) throw new Error('Too many events before turn confirmation');
          early.push(n);
        }
      } catch (error) { finish({ status: 'interrupted', error: message(error), retireSession: true }); interrupt(); }
    };
    const activity = (a: { threadId: string; turnId?: string }) => {
      if (a.threadId === threadId && turnId && (!a.turnId || a.turnId === turnId)) idle();
    };
    const exit = (error: Error) => finish({ status: 'interrupted', error: error.message, retireSession: true });
    const abort = () => { finish({ status: 'interrupted', error: 'Turn interrupted during daemon shutdown', retireSession: true }); interrupt(); };
    if (options.signal.aborted) { finish({ status: 'interrupted', error: 'Daemon stopped before turn/start' }); return; }
    provider.on('notification', notification); provider.on('exit', exit); provider.on('activity', activity);
    options.signal.addEventListener('abort', abort, { once: true });
    startTimer = setTimeout(uncertain, options.startTimeoutMs ?? 30_000);
    // Promise.resolve also converts a synchronous adapter throw into one outcome.
    void Promise.resolve().then(() => {
      if (done) return undefined;
      try { options.onSubmitting?.(); }
      catch (error) { finish({ status: 'failed', error: message(error), noExecution: true }); return undefined; }
      return provider.request('turn/start', { threadId, input: [{ type: 'text', text }] }, options.startTimeoutMs ?? 30_000);
    }).then(result => {
      if (!result) return;
      if (done) {
        // The native thread is retired before the lane is reused; its adapter also handles late receipts.
        if (!turnId) { turnId = result.turn.id; interrupt(); }
        return;
      }
      try {
        started(result.turn.id);
        if (result.turn.status !== 'inProgress') consume({ method: 'turn/completed', params: { threadId, turn: result.turn } });
      }
      catch (error) { finish({ status: 'interrupted', error: message(error), retireSession: true }); interrupt(); }
    }, error => {
      if (done || turnId) return;
      if (error instanceof Error && error.name === 'RpcResponseError') finish({ status: 'failed', error: message(error), noExecution: true });
      else uncertain();
    });
  });
}
