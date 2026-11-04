import { Store, resolveDatabasePath } from '../store';
import { Daemon, type DaemonOptions } from '../daemon';
import { DaemonLock, lockOwnerAlive } from '../daemon/lock';
import { AgentRegistry } from '../agents';
import { SqliteMailbox } from '../mailbox';
import { installRpcSignalHandlers } from '../rpc';
import type { LaneStatus } from '../scheduler';

export const daemonUsage = `Usage: kru daemon [--db <path>] [--max-turns <count>] [--poll-ms <ms>]
                  [--idle-timeout-ms <ms>] [--start-timeout-ms <ms>] [--start-grace-ms <ms>]
                  [--shutdown-grace-ms <ms>] [--budget-timezone <IANA-zone>] [--max-hops <count>] [--handoff-chars <count>]
       kru status [--db <path>] [--json]`;
function parse(args: string[]): { path: string | undefined; values: Map<string, number>; json: boolean; budgetTimezone: string | undefined } {
  let path: string | undefined, json = false;
  let budgetTimezone: string | undefined;
  const values = new Map<string, number>();
  const allowed = args[0] === 'daemon' ? ['--max-turns', '--poll-ms', '--idle-timeout-ms', '--start-timeout-ms', '--start-grace-ms', '--shutdown-grace-ms', '--max-hops', '--handoff-chars'] : [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--db') {
      if (path !== undefined) throw new Error('Repeated --db');
      path = args[++i]; if (!path || path.startsWith('--')) throw new Error('Expected database path');
    } else if (arg === '--budget-timezone' && args[0] === 'daemon') {
      if (budgetTimezone !== undefined) throw new Error('Repeated --budget-timezone');
      budgetTimezone = args[++i];
      if (!budgetTimezone || budgetTimezone.startsWith('--')) throw new Error('Expected budget timezone');
    } else if (arg === '--json' && args[0] === 'status') json = true;
    else if (allowed.includes(arg)) {
      if (values.has(arg)) throw new Error(`Repeated option ${arg}`);
      const value = Number(args[++i]);
      if (!Number.isSafeInteger(value) || value < (arg === '--shutdown-grace-ms' || arg === '--max-hops' ? 0 : 1) || value > 2_147_483_647) throw new Error(`Invalid ${arg}`);
      values.set(arg, value);
    } else throw new Error(`Unknown argument ${arg}`);
  }
  return { path, values, json, budgetTimezone };
}
export async function daemonCommand(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(daemonUsage); return 0; }
  const parsed = parse(args), store = new Store(resolveDatabasePath(parsed.path));
  try {
    if (args[0] === 'status') { printStatus(store, parsed.json); return 0; }
    const options: DaemonOptions = { ...(parsed.budgetTimezone !== undefined ? { budgetTimezone: parsed.budgetTimezone } : {}) };
    for (const [flag, key] of [['--max-turns', 'maxTurns'], ['--poll-ms', 'pollMs'], ['--idle-timeout-ms', 'idleTimeoutMs'],
      ['--start-timeout-ms', 'startTimeoutMs'], ['--start-grace-ms', 'startGraceMs'], ['--shutdown-grace-ms', 'shutdownGraceMs'], ['--max-hops', 'maxHops'], ['--handoff-chars', 'handoffChars']] as const) {
      if (parsed.values.has(flag)) options[key] = parsed.values.get(flag)!;
    }
    const daemon = new Daemon(store, options);
    const signals = installRpcSignalHandlers([daemon]);
    try {
      daemon.start();
      console.error('Kru daemon ready');
      await daemon.closed;
      if (daemon.failure) throw daemon.failure;
      return signals.exitCode ?? 0;
    } finally { await daemon.stop(0); signals.dispose(); }
  } finally { store.close(); }
}
function printStatus(store: Store, json: boolean): void {
  const agents = new AgentRegistry(store), mailbox = new SqliteMailbox(store);
  const lock = new DaemonLock(store).read();
  const alive = lock ? lockOwnerAlive(lock) : false;
  const snapshot = alive && lock ? JSON.parse(lock.status_json) as { lanes?: LaneStatus[]; activeTurns?: number; budgetTimezone?: string } : {};
  const active = mailbox.activeLanes();
  const lanes = mailbox.listLanes().map(lane => {
    const agent = agents.get(lane.agentId)!;
    const running = active.find(a => a.agentId === lane.agentId && a.laneId === lane.laneId);
    const observed = snapshot.lanes?.find(s => s.agentId === lane.agentId && s.laneId === lane.laneId);
    return { agent: agent.name, agentId: agent.id, lane: lane.laneId ?? 'main', daemonAlive: alive,
      ...(observed ?? {}),
      state: running ? (running.turnId ? 'running' : 'starting') : alive ? observed?.state ?? 'queued' : 'queued',
      ...(running ? { batchId: running.batchId, turnId: running.turnId, reason: undefined } : {}),
      queued: mailbox.listQueue(agent.id, lane.laneId).filter(d => d.status === 'queued').length };
  });
  if (json) { console.log(JSON.stringify({ daemon: alive ? { pid: lock!.pid, heartbeatAt: lock!.heartbeat_at, budgetTimezone: snapshot.budgetTimezone } : null, lanes })); return; }
  if (!alive) console.log('daemon offline');
  if (!lanes.length) console.log('no queued or active work');
  for (const lane of lanes) {
    const detail = lane.reason === 'budget' ? lane.dailyUsd !== undefined
      ? `budget (${lane.budgetDetail}; $${(lane.usedUsd ?? 0).toFixed(6)} of $${lane.dailyUsd} today)`
      : `budget (${lane.usedTokens} of ${lane.dailyTokens} tokens today)`
      : lane.reason ?? (lane.turnId ? `turn ${lane.turnId}` : '');
    console.log(`${JSON.stringify(lane.agent)} ${JSON.stringify(lane.lane)} ${lane.state} ${detail}${lane.batchSize ? ` batch of ${lane.batchSize}` : ''}`.trim());
  }
}
