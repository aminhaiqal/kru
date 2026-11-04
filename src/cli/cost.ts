import { Store, resolveDatabasePath } from '../store';
import { AgentRegistry } from '../agents';
import { SqliteUsageLedger } from '../usage/sqlite';
import { nanoUsd } from '../usage/pricing';

export function costCommand(args: string[]): number {
  if (args.includes('--help')) {
    console.log('Usage: kru cost [--agent <agent>] [--json] [--db <path>]\n       kru cost acknowledge <batch> --tokens <upper-bound> --usd <upper-bound> --note <reason> [--db <path>]'); return 0;
  }
  const values = new Map<string, string>(); const words: string[] = []; let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') { json = true; continue; }
    if (arg.startsWith('--')) {
      if (!['--db', '--agent', '--tokens', '--usd', '--note'].includes(arg) || values.has(arg)) throw new Error(`Invalid option ${arg}`);
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing ${arg}`);
      values.set(arg, value);
    } else words.push(arg);
  }
  const store = new Store(resolveDatabasePath(values.get('--db')));
  try {
    const ledger = new SqliteUsageLedger(store), agents = new AgentRegistry(store);
    if (words[0] === 'acknowledge' && words.length === 2) {
      if (!values.has('--tokens') || !values.has('--usd') || !values.has('--note')) throw new Error('Provide --tokens, --usd and --note');
      ledger.acknowledge(words[1]!, Number(values.get('--tokens')), nanoUsd(Number(values.get('--usd'))), values.get('--note')!);
      console.log(`acknowledged usage bound for ${words[1]}`); return 0;
    }
    if (words.length || ['--tokens', '--usd', '--note'].some(k => values.has(k))) throw new Error('Expected kru cost (see --help)');
    const agent = values.has('--agent') ? agents.resolve(values.get('--agent')!) : undefined;
    if (values.has('--agent') && !agent) throw new Error('Unknown agent');
    const records = ledger.list(agent?.id);
    const rows = records.map(r => ({ batchId: r.batchId, agent: agents.get(r.agentId)?.name ?? r.agentId, model: r.model,
      tokens: r.resolution?.tokens ?? r.usage?.last.totalTokens ?? null,
      minimumUsd: r.resolution ? r.resolution.nanoUsd / 1e9 : r.cost?.minimumNanoUsd == null ? null : r.cost.minimumNanoUsd / 1e9,
      maximumUsd: r.resolution ? r.resolution.nanoUsd / 1e9 : r.cost?.maximumNanoUsd == null ? null : r.cost.maximumNanoUsd / 1e9,
      complete: r.resolution !== null || r.complete, scope: 'main-agent token estimate', outcome: r.outcome,
      price: r.cost?.price ?? null, resolution: r.resolution }));
    const minimumUsd = rows.reduce((n, r) => n + (r.minimumUsd ?? 0), 0), maximumUsd = rows.reduce((n, r) => n + (r.maximumUsd ?? 0), 0);
    const unknown = rows.filter(r => !r.complete || r.maximumUsd === null).length;
    if (json) console.log(JSON.stringify({ currency: 'USD', estimated: true, minimumUsd, maximumUsd, unknown, turns: rows }));
    else {
      for (const row of rows) console.log(`${row.batchId} ${JSON.stringify(row.agent)} ${row.model} ${row.maximumUsd === null ? 'unpriced' : `$${row.minimumUsd!.toFixed(6)}–$${row.maximumUsd.toFixed(6)}`} ${row.complete ? row.outcome : 'usage unknown'}`);
      console.log(`estimated main-agent token cost: $${minimumUsd.toFixed(6)}–$${maximumUsd.toFixed(6)} USD${unknown ? `; ${unknown} incomplete/unpriced records (total is not complete)` : ''}`);
    }
    return 0;
  } finally { store.close(); }
}
