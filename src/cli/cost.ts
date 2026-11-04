import { Store, resolveDatabasePath } from '../store';
import { AgentRegistry } from '../agents';
import { SqliteUsageLedger } from '../usage/sqlite';
import { nanoUsd } from '../usage/pricing';

export function costCommand(args: string[]): number {
  if (args.includes('--help')) {
    console.log('Usage: kru cost [--agent <agent>] [--by agent|model|chain] [--since 7d|<ISO timestamp>] [--json] [--db <path>]\n       kru cost acknowledge <batch> --tokens <upper-bound> --usd <upper-bound> --note <reason> [--db <path>]'); return 0;
  }
  const values = new Map<string, string>(); const words: string[] = []; let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') { json = true; continue; }
    if (arg.startsWith('--')) {
      if (!['--db', '--agent', '--tokens', '--usd', '--note', '--by', '--since'].includes(arg) || values.has(arg)) throw new Error(`Invalid option ${arg}`);
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing ${arg}`);
      values.set(arg, value);
    } else words.push(arg);
  }
  const by = values.get('--by');
  if (by !== undefined && !['agent', 'model', 'chain'].includes(by)) throw new Error('Expected --by agent, model or chain');
  const since = values.get('--since');
  const days = since?.match(/^(\d+)d$/);
  const sinceTime = since === undefined ? undefined : days ? Date.now() - Number(days[1]) * 86400_000
    : /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(since) ? Date.parse(since) : NaN;
  if (sinceTime !== undefined && (!Number.isFinite(sinceTime) || !Number.isFinite(new Date(sinceTime).getTime()))) throw new Error('Invalid --since; use 7d or an ISO timestamp with timezone');
  const store = new Store(resolveDatabasePath(values.get('--db')));
  try {
    const ledger = new SqliteUsageLedger(store), agents = new AgentRegistry(store);
    if (words[0] === 'acknowledge' && words.length === 2) {
      if (by || since || values.has('--agent')) throw new Error('Cost acknowledgement does not accept report filters');
      if (!values.has('--tokens') || !values.has('--usd') || !values.has('--note')) throw new Error('Provide --tokens, --usd and --note');
      ledger.acknowledge(words[1]!, Number(values.get('--tokens')), nanoUsd(Number(values.get('--usd'))), values.get('--note')!);
      console.log(`acknowledged usage bound for ${words[1]}`); return 0;
    }
    if (words.length || ['--tokens', '--usd', '--note'].some(k => values.has(k))) throw new Error('Expected kru cost (see --help)');
    const agent = values.has('--agent') ? agents.resolve(values.get('--agent')!) : undefined;
    if (values.has('--agent') && !agent) throw new Error('Unknown agent');
    const records = ledger.list(agent?.id).filter(r => sinceTime === undefined || Date.parse(r.recordedAt ?? r.startedAt) >= sinceTime);
    const rows = records.map(r => ({ batchId: r.batchId, agent: agents.get(r.agentId)?.name ?? r.agentId, model: r.model,
      tokens: r.resolution?.tokens ?? r.usage?.last.totalTokens ?? null,
      minimumUsd: r.resolution ? r.resolution.nanoUsd / 1e9 : r.cost?.minimumNanoUsd == null ? null : r.cost.minimumNanoUsd / 1e9,
      maximumUsd: r.resolution ? r.resolution.nanoUsd / 1e9 : r.cost?.maximumNanoUsd == null ? null : r.cost.maximumNanoUsd / 1e9,
      complete: r.resolution !== null || r.complete, scope: 'main-agent token estimate', outcome: r.outcome,
      input: r.usage?.last.inputTotal ?? null, cached: r.usage?.last.cachedRead ?? null,
      cacheWrite: r.usage?.last.cacheWrite ?? null, output: r.usage?.last.output ?? null,
      agentId: r.agentId, laneId: r.laneId ?? null, chainIds: r.chainIds, cause: r.cause, recordedAt: r.recordedAt ?? r.startedAt,
      priceId: r.priceId ?? null, price: r.cost?.price ?? null, resolution: r.resolution }));
    const minimumUsd = records.reduce((n, r) => n + (r.resolution?.nanoUsd ?? r.cost?.minimumNanoUsd ?? 0), 0) / 1e9;
    const maximumUsd = records.reduce((n, r) => n + (r.resolution?.nanoUsd ?? r.cost?.maximumNanoUsd ?? 0), 0) / 1e9;
    const unknown = rows.filter(r => !r.complete || r.maximumUsd === null).length;
    const groups = new Map<string, { key: string; turns: number; input: number; cached: number; output: number; minimumUsd: number; maximumUsd: number; unknown: number }>();
    if (by) for (const row of rows) {
      // A multi-chain user batch is one shared chain-set bucket, never charged once per member.
      const key = by === 'agent' ? row.agent : by === 'model' ? row.model : JSON.stringify([...row.chainIds].sort());
      const group = groups.get(key) ?? { key, turns: 0, input: 0, cached: 0, output: 0, minimumUsd: 0, maximumUsd: 0, unknown: 0 };
      group.turns++; group.input += row.input ?? 0; group.cached += row.cached ?? 0; group.output += row.output ?? 0;
      group.minimumUsd += row.minimumUsd ?? 0; group.maximumUsd += row.maximumUsd ?? 0;
      if (!row.complete || row.maximumUsd === null) group.unknown++;
      groups.set(key, group);
    }
    if (json) console.log(JSON.stringify({ currency: 'USD', estimated: true, minimumUsd, maximumUsd, unknown, turns: rows, ...(by ? { by, groups: [...groups.values()] } : {}) }));
    else {
      if (by) {
        console.log(`${by}\tturns\tinput\tcached\toutput\testimated USD`);
        for (const row of groups.values()) console.log(`${JSON.stringify(row.key)}\t${row.turns}\t${row.input}\t${row.cached}\t${row.output}\t$${row.minimumUsd.toFixed(6)}–$${row.maximumUsd.toFixed(6)}${row.unknown ? `; ${row.unknown} incomplete/unpriced` : ''}`);
        if (unknown) console.log(`unpriced/incomplete\t${unknown}\tn/a (excluded unknown cost; never free)`);
      } else for (const row of rows) console.log(`${row.batchId} ${JSON.stringify(row.agent)} ${row.model} ${row.maximumUsd === null ? 'unpriced' : `$${row.minimumUsd!.toFixed(6)}–$${row.maximumUsd.toFixed(6)}`} ${row.complete ? row.outcome : 'usage unknown'}`);
      console.log(`estimated main-agent token cost: $${minimumUsd.toFixed(6)}–$${maximumUsd.toFixed(6)} USD${unknown ? `; ${unknown} incomplete/unpriced records (total is not complete)` : ''}`);
    }
    return 0;
  } finally { store.close(); }
}
