import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, verifyReplay } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { Daemon } from '../src/daemon';
import { FakeProvider } from '../src/providers';
import { readLog } from '../src/turns';

const directory = mkdtempSync(join(tmpdir(), 'kru-m5-demo-')), path = join(directory, 'kru.sqlite');
const store = new Store(path), agents = new AgentRegistry(store), mailbox = new SqliteMailbox(store);
const coder = agents.create({ name: 'coder', provider: 'fake' }), reviewer = agents.create({ name: 'reviewer', provider: 'fake' });
const daemon = new Daemon(store, { maxTurns: 1 }, agent => new FakeProvider({ script: async (input, tool) => {
  if (agent.id === reviewer.id) return 'Review complete: the parser validates the whole input.';
  if (input.startsWith('Kru delivery context:')) return 'Review received. I can finish the change.';
  const roster = await tool('list_agents', {}); if (!roster.success) throw new Error('Roster lookup failed');
  const queued = await tool('send_message', { to: ['reviewer'], text: 'Please review the parser change.', expectsReply: true });
  if (!queued.success) throw new Error(queued.contentItems[0]!.text);
  return 'Review queued. This turn ends without waiting.';
} }));
try {
  mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [coder.id], text: 'Ask the reviewer to check the parser.' });
  daemon.start(); const deadline = performance.now() + 5000;
  while (true) {
    const rows = store.db.query<{ status: string }, []>('SELECT status FROM deliveries').all();
    if (rows.length === 3 && rows.every(r => r.status === 'completed')) break;
    if (daemon.failure) throw daemon.failure;
    if (performance.now() > deadline) throw new Error('Messaging demo timed out');
    await Bun.sleep(5);
  }
  await daemon.stop(0);
  const child = Bun.spawn([process.execPath, new URL('../src/cli/index.ts', import.meta.url).pathname, 'cost', '--by', 'chain', '--json', '--db', path], { stdout: 'pipe', stderr: 'pipe' });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(error);
  const report = { provider: 'fake', modelCalls: 0, maxHops: 4,
    deliveries: store.db.query('SELECT d.seq, a.name AS recipient, d.status, d.hop, d.chain_id, m.expects_reply, m.text FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN agents a ON a.id=d.recipient_id ORDER BY d.seq').all(),
    coderLog: readLog(store, coder.id), reviewerLog: readLog(store, reviewer.id), cost: JSON.parse(output), replay: verifyReplay(store) };
  if (process.argv[2]) writeFileSync(process.argv[2]!, JSON.stringify(report, null, 2) + '\n');
  console.log('coder → reviewer → coder: three completed turns, one chain, hops 0 → 1 → 2');
  console.log('Reply requests: false → true → false. No further acknowledgement turn.');
  console.log(`Cost: ${report.cost.groups[0].turns} turns, ${report.cost.turns.reduce((n: number, r: { tokens: number }) => n + r.tokens, 0)} tokens, $${report.cost.maximumUsd.toFixed(6)} (deterministic fake).`);
  console.log(`Replay: ${report.replay.events} events; ${report.replay.projections} projections match.`);
} finally { await daemon.stop(0); store.close(); rmSync(directory, { recursive: true, force: true }); }
