import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoHandoff } from '../scripts/demo-handoff';
import { Store, verifyReplay } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { Daemon } from '../src/daemon';
import { ClaudeProvider, FakeProvider } from '../src/providers';
import { scriptedClaude } from './fakes/claude-sdk';
import { SqliteHistory } from '../src/threads';
import { SqliteSessions } from '../src/daemon/sessions';

test('M6 acceptance: ten Claude turns, CLI switch to Codex, first-turn history survives', async () => {
  const report = await demoHandoff();
  expect(Object.values(report.assertions).every(Boolean)).toBe(true);
  expect(report.modelCalls).toBe(0);
}, 10000);

const dirs: string[] = [], daemons: Daemon[] = [], stores: Store[] = [];
afterEach(async () => { for (const d of daemons.splice(0)) await d.stop(0); for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d,{ recursive:true,force:true }); });
async function until(fn: () => boolean) { const end=performance.now()+3000; while(!fn()){ if(performance.now()>end)throw new Error('Timed out'); await Bun.sleep(3); } }
function setup() {
  const dir=mkdtempSync(join(tmpdir(),'kru-m6-native-')); dirs.push(dir); const path=join(dir,'db.sqlite'), store=new Store(path); stores.push(store);
  return {store,path,agents:new AgentRegistry(store),mailbox:new SqliteMailbox(store)};
}
test('Claude MCP history_search retrieves full entries and rejects invalid cursors without stopping the daemon',async()=>{
  const {store,agents,mailbox}=setup(); const a=agents.create({name:'a',provider:'fake'});
  const enqueue=(text:string)=>mailbox.enqueue({sender:{kind:'user'},recipientIds:[a.id],text}).deliveryIds[0]!;
  const first=enqueue('Remember the complete answer'); const initial=new Daemon(store,{},()=>new FakeProvider({script:async()=> 'retained-'.repeat(200)})); daemons.push(initial); initial.start();
  await until(()=>mailbox.get(first)!.status==='completed'); await initial.stop(0);
  const entry=new SqliteHistory(store).search(a.id,null,'Remember').entries.find(e=>e.role==='user')!.relatedEntryId!;
  agents.update(a.id,{provider:'claude'});
  let args:Record<string,unknown>={entryId:entry,offset:800};
  const provider=new ClaudeProvider({query: input=>scriptedClaude('tool',undefined,{name:'history_search',arguments:args})(input)});
  const d=new Daemon(store,{},()=>provider); daemons.push(d); d.start(); const next=enqueue('Retrieve the next chunk'); await until(()=>mailbox.get(next)!.status==='completed');
  const answer=()=>store.db.query<{text:string},[]>('SELECT text FROM thread_messages ORDER BY seq DESC LIMIT 1').get()!.text;
  const page=JSON.parse(answer()); expect(page.offset).toBe(800); expect(page.entries[0].text).toBe('retained-'.repeat(200).slice(800,1600)); expect(page.nextOffset).toBe(1600);
  // A fresh query instance uses the new scripted arguments while preserving native MCP validation.
  await d.stop(0); args={query:'Remember',cursor:'invalid'};
  const invalid=new Daemon(store,{},()=>new ClaudeProvider({query:scriptedClaude('tool',undefined,{name:'history_search',arguments:args})})); daemons.push(invalid); invalid.start();
  const bad=enqueue('Try an invalid cursor'); await until(()=>['completed','failed'].includes(mailbox.get(bad)!.status));
  expect(mailbox.get(bad)!.error).toContain('cursor'); expect(invalid.failure).toBeUndefined(); expect(verifyReplay(store).matches).toBe(true);
});

test('history tool rejects caller-supplied scope and conflicting retrieval modes',async()=>{
  const {store,agents,mailbox}=setup(); const a=agents.create({name:'a',provider:'fake'});
  const results: boolean[]=[];
  const d=new Daemon(store,{},()=>new FakeProvider({script:async(_input,tool)=>{
    for(const args of [{query:'secret',agentId:'foreign'},{entryId:'item:1',query:'secret'},{query:'secret',offset:1}]) {
      const result=await tool('history_search',args); results.push(result.success);
    }
    return 'done';
  }})); daemons.push(d);d.start();
  const id=mailbox.enqueue({sender:{kind:'user'},recipientIds:[a.id],text:'validate'}).deliveryIds[0]!;
  await until(()=>mailbox.get(id)!.status==='completed'); expect(results).toEqual([false,false,false]); expect(d.failure).toBeUndefined();
});

test('switching back starts fresh rather than resuming an inactive provider cache',async()=>{
  const {store,agents,mailbox}=setup(); const a=agents.create({name:'a',provider:'fake'});
  const seen:string[]=[]; const d=new Daemon(store,{},()=>new FakeProvider({script:async input=>{seen.push(input);return'ack';}})); daemons.push(d); d.start();
  const send=async(text:string)=>{const id=mailbox.enqueue({sender:{kind:'user'},recipientIds:[a.id],text}).deliveryIds[0]!;await until(()=>mailbox.get(id)!.status==='completed');};
  await send('first fact'); const sessions=new SqliteSessions(store), original=sessions.get(a.id,null,'fake')!;
  agents.update(a.id,{provider:'codex'}); await send('middle fact');
  agents.update(a.id,{provider:'fake'}); await send('last question');
  const current=sessions.get(a.id,null,'fake')!; expect(current.nativeThreadId).not.toBe(original.nativeThreadId); expect(current.logicalThreadId).toBe(original.logicalThreadId);
  expect(seen[2]).toContain('first fact'); expect(seen[2]).toContain('middle fact'); expect(seen[2]).toEndWith('last question');
  expect(store.db.query('SELECT * FROM provider_sessions WHERE active=1').all()).toHaveLength(1);
});

test('daemon CLI rejects handoff budgets outside 512–16000',async()=>{
  const {path}=setup();
  for(const value of ['0','511','16001','1.5','x']){
    const child=Bun.spawn([process.execPath,new URL('../src/cli/index.ts',import.meta.url).pathname,'daemon','--handoff-chars',value,'--db',path],{stdout:'pipe',stderr:'pipe'});
    expect(await child.exited).toBe(1); expect(await new Response(child.stderr).text()).toMatch(/handoffChars|handoff-chars/);
  }
});
