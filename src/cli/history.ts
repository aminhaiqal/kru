import { Store, resolveDatabasePath } from '../store';
import { AgentRegistry } from '../agents';
import { readLog } from '../turns/log';
import { verifyReplay } from '../store/replay';

export async function historyCommand(command: 'log' | 'replay', args: string[]): Promise<number> {
  if (args.includes('--help')) {
    console.log(command === 'log' ? 'Usage: kru log <agent> [--lane <lane>|--main] [--follow] [--json] [--db <path>]' : 'Usage: kru replay --verify [--json] [--db <path>]'); return 0;
  }
  const values = new Map<string, string>(), flags = new Set<string>(), words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (['--json', ...(command === 'log' ? ['--follow', '--main'] : ['--verify'])].includes(arg)) {
      if (flags.has(arg)) throw new Error(`Repeated ${arg}`); flags.add(arg);
    } else if (['--db', ...(command === 'log' ? ['--lane'] : [])].includes(arg)) {
      const value = args[++i]; if (!value || value.startsWith('--') || values.has(arg)) throw new Error(`Invalid ${arg}`); values.set(arg, value);
    } else if (arg.startsWith('--')) throw new Error(`Unknown ${arg}`);
    else words.push(arg);
  }
  if (command === 'replay' ? words.length !== 0 || !flags.has('--verify') : words.length !== 1 || (flags.has('--main') && values.has('--lane'))) throw new Error(`Expected kru ${command} (see --help)`);
  const store = new Store(resolveDatabasePath(values.get('--db')));
  try {
    if (command === 'replay') {
      const report = verifyReplay(store);
      console.log(flags.has('--json') ? JSON.stringify(report) : `replayed ${report.events} events; ${report.projections} projections ${report.matches ? 'match' : `differ: ${report.differences.join(', ')}`}`);
      return report.matches ? 0 : 1;
    }
    const agent = new AgentRegistry(store).resolve(words[0]!); if (!agent) throw new Error(`Unknown agent: ${words[0]}`);
    const lane = flags.has('--main') ? null : values.get('--lane');
    const seen = new Map<string, string>();
    const print = () => {
      for (const entry of readLog(store, agent.id, lane, flags.has('--follow'))) {
        const value = JSON.stringify(entry);
        if (seen.get(entry.id) === value) continue;
        const old = seen.get(entry.id); seen.set(entry.id, value);
        // Finalizing an unchanged scratch item should not print its text twice.
        if (!flags.has('--json') && old && JSON.parse(old).text === entry.text) {
          if (JSON.parse(old).partial && !entry.partial) console.log(`${entry.timestamp} ${entry.role}: (complete)`);
          continue;
        }
        console.log(flags.has('--json') ? value : `${entry.timestamp} ${entry.role}${entry.partial ? ' (partial)' : ''}: ${entry.text ?? JSON.stringify(entry.details ?? {})}`);
      }
    };
    print();
    if (!flags.has('--follow')) return 0;
    await new Promise<void>((resolve, reject) => {
      let version = store.db.query<{ data_version: number }, []>('PRAGMA data_version').get()!.data_version;
      const cleanup = () => { clearInterval(timer); process.off('SIGINT', finish); process.off('SIGTERM', finish); };
      const finish = () => { cleanup(); resolve(); };
      const timer = setInterval(() => {
        try { const next = store.db.query<{ data_version: number }, []>('PRAGMA data_version').get()!.data_version; if (next !== version) { version = next; print(); } }
        catch (error) { cleanup(); reject(error); }
      }, 100);
      process.on('SIGINT', finish); process.on('SIGTERM', finish);
      // Close the gap between the initial read and installing the poll baseline.
      print();
    });
    return 0;
  } finally { store.close(); }
}
