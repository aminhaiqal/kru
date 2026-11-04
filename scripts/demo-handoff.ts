import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, verifyReplay } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { Daemon } from '../src/daemon';
import { ClaudeProvider, CodexProvider } from '../src/providers';
import { ThreadStore } from '../src/threads';
import { SqliteSessions } from '../src/daemon/sessions';
import { scriptedClaude } from '../test/fakes/claude-sdk';

/** Exercises native adapter protocols and persistence; makes no live model calls. */
export async function demoHandoff() {
  const directory = mkdtempSync(join(tmpdir(), 'kru-m6-demo-')), path = join(directory, 'kru.sqlite');
  const store = new Store(path), agents = new AgentRegistry(store), mailbox = new SqliteMailbox(store);
  const capture = join(directory, 'codex.jsonl');
  const firstFact = 'The launch code is indigo-otter-472.';
  let nativeStarts=0;
  const agent = agents.create({ name: 'teammate', provider: 'claude', config: { model: 'scripted-claude', promptProfile: 'full' } });
  const daemon = new Daemon(store, {}, a => {const provider=a.provider === 'claude'
    ? new ClaudeProvider({ query: scriptedClaude() })
    : new CodexProvider({ transport: { command: process.execPath,
      args: [new URL('../test/fakes/provider-agent.ts', import.meta.url).pathname],
      env: { KRU_CAPTURE_FILE: capture, KRU_SCRIPTED_TOOL: 'history_search', KRU_SCRIPTED_TOOL_ARGS: JSON.stringify({ query: 'launch code' }) },
      processRecordDir: join(directory, 'processes'), stopGraceMs: 50 } });provider.on('notification',n=>{if(n.method==='turn/started')nativeStarts++;});return provider;});
  const turn = async (text: string) => {
    const id = mailbox.enqueue({ sender: { kind: 'user' }, recipientIds: [agent.id], text }).deliveryIds[0]!;
    const deadline = performance.now() + 5000;
    while (mailbox.get(id)!.status !== 'completed') {
      if (daemon.failure) throw daemon.failure;
      if (['failed','interrupted'].includes(mailbox.get(id)!.status)) throw new Error(mailbox.get(id)!.error ?? 'Turn failed');
      if (performance.now() > deadline) throw new Error('Handoff demo timed out');
      await Bun.sleep(5);
    }
    return id;
  };
  try {
    daemon.start();
    const firstDelivery=await turn('First-turn background. '.repeat(1000)+firstFact);
    for (let n = 2; n <= 10; n++) await turn(`Turn ${n}: unrelated planning note ${n}.`);
    const before = new ThreadStore(store).get(agent.id, null)!;
    const old = new SqliteSessions(store).get(agent.id, null, 'claude')!;
    const child = Bun.spawn([process.execPath, new URL('../src/cli/index.ts', import.meta.url).pathname,
      'agent', 'set', 'teammate', '--provider', 'codex', '--db', path], { stdout: 'pipe', stderr: 'pipe' });
    const [code, , error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(error);
    const request = 'What launch code did I give you in our first turn? Search our history.';
    await turn(request);
    await daemon.stop(0);
    const binding = new SqliteSessions(store).get(agent.id, null, 'codex')!;
    const wire = readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const input: string = wire.find(m => m.method === 'turn/start').params.input[0].text;
    const answer = store.db.query<{ text: string }, []>("SELECT text FROM thread_messages WHERE type='agentMessage' ORDER BY seq DESC LIMIT 1").get()!.text;
    const turns = store.db.query<{ provider: string; status: string }, []>('SELECT provider,status FROM turns ORDER BY started_at,id').all();
    const replay = verifyReplay(store);
    const assertions = {
      tenClaudeTurns: turns.filter(t => t.provider === 'claude' && t.status === 'completed').length === 10,
      oneCodexTurn: turns.filter(t => t.provider === 'codex' && t.status === 'completed').length === 1,
      stableThread: binding.logicalThreadId === before.id,
      newNativeSession: binding.nativeThreadId !== old.nativeThreadId,
      boundedHandoff: [...input.split('\n--- end handoff; current request follows ---')[0]!].length + '\n--- end handoff; current request follows ---'.length <= 12000&&Buffer.byteLength(input)<=32768,
      firstFactOmittedFromHandoff: !input.includes(firstFact), currentRequestLast: input.endsWith(request),
      firstFactRetrieved: answer.includes(firstFact), handoffAcknowledged: binding.handoffPending === false,
      allTurnsLinked: (store.db.query<{ n: number }, [string]>('SELECT count(*) AS n FROM turn_threads WHERE thread_id=?').get(before.id)!.n === 11),
      providerOnlyCliSwitch: agents.get(agent.id)!.config.model === undefined && agents.get(agent.id)!.config.promptProfile === 'minimal',
      replayMatches: replay.matches,
      noHiddenTurns:nativeStarts===11&&(store.db.query<{n:number},[]>('SELECT count(*) AS n FROM usage_records').get()!.n===11),
      retrievedOriginalSource:answer.includes(mailbox.get(firstDelivery)!.messageId),
      confirmedHandoffUse:store.db.query('SELECT * FROM handoff_uses').all().length===1,
    };
    if (Object.values(assertions).some(ok => !ok)) throw new Error(JSON.stringify(assertions));
    return { mode: 'scripted native adapters', modelCalls: 0, firstFact, threadId: before.id, assertions,
      turns, input, answer, replay,
      bindings: store.db.query('SELECT provider,native_thread_id,thread_id,active,handoff_pending FROM provider_sessions ORDER BY provider').all() };
  } finally { await daemon.stop(0); store.close(); rmSync(directory, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const report = await demoHandoff();
  if (process.argv[2]) writeFileSync(process.argv[2]!, JSON.stringify(report, null, 2) + '\n');
  console.log('10 Claude turns → provider-only CLI switch → 1 Codex turn.');
  console.log('The first-turn launch code is omitted from the bounded handoff and restored by history_search.');
  console.log(`Replay: ${report.replay.events} events; ${report.replay.projections} projections match.`);
  console.log('Scripted native adapters; zero live model calls.');
}
