import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync,unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, verifyReplay, snapshot } from '../../src/store';
import { AgentRegistry } from '../../src/agents';
import { SqliteMailbox } from '../../src/mailbox';
import { Daemon, type DaemonOptions } from '../../src/daemon';
import { DaemonLock } from '../../src/daemon/lock';
import { SqliteSessions } from '../../src/daemon/sessions';
import { FakeProvider } from '../../src/providers';
import { SqliteUsageLedger } from '../../src/usage/sqlite';
import { tokenCount } from '../../src/providers/token-usage';
import { BudgetCalendar } from '../../src/scheduler/budget-day';
import { TurnRecorder } from '../../src/turns/recorder';
import { SqliteHistory, ThreadStore } from '../../src/threads';
import { recoverExecution } from '../../src/boot/recover-execution';
import { recoveryReport } from '../../src/boot/report';
import { containProcess, type ContainmentOps } from '../../src/boot/containment';
import { processStartIdentity, readProcessRecords, type RpcProcessRecord } from '../../src/rpc/process-record';
import { hostIdentity, processGroupMembers } from '../../src/rpc/process-inspection';
import { ToolRouter, SqliteToolState } from '../../src/tools';
import type { ToolCall, ToolResult } from '../../src/providers/protocol';

const directories:string[]=[],stores:Store[]=[],daemons:Daemon[]=[];
const children:ReturnType<typeof Bun.spawn>[]=[];
async function until(fn:()=>boolean,timeout=6000){const end=performance.now()+timeout;while(!fn()){if(performance.now()>end)throw new Error('Condition timed out');await Bun.sleep(5);}}
function env(){const dir=mkdtempSync(join(tmpdir(),'kru-m7-'));directories.push(dir);const path=join(dir,'db.sqlite'),store=new Store(path);stores.push(store);return{dir,path,store,agents:new AgentRegistry(store),mailbox:new SqliteMailbox(store),ledger:new SqliteUsageLedger(store)};}
type Env=ReturnType<typeof env>;
const send=(e:Env,id:string,text='work',laneId:string|null=null)=>e.mailbox.enqueue({sender:{kind:'user'},recipientIds:[id],text,laneId}).deliveryIds[0]!;
function daemon(e:Env,options:DaemonOptions={},factory:ConstructorParameters<typeof Daemon>[2]=()=>new FakeProvider()){
  const d=new Daemon(e.store,{...options,recovery:{graceMs:20,...options.recovery}},factory);daemons.push(d);d.start();return d;
}
function child(e:Env,point='',mode='stall'){
  const p=Bun.spawn([process.execPath,new URL('./daemon-child.ts',import.meta.url).pathname,e.path,point,mode],{stdout:'pipe',stderr:'pipe'});children.push(p);
  const lines:string[]=[];void(async()=>{const reader=p.stdout.getReader();let text='';for(;;){const r=await reader.read();if(r.done)break;text+=new TextDecoder().decode(r.value);let n;while((n=text.indexOf('\n'))>=0){lines.push(text.slice(0,n));text=text.slice(n+1);}}})();
  const error=new Response(p.stderr).text();return {p,lines,error};
}
async function paused(c:ReturnType<typeof child>,point:string){await until(()=>c.lines.some(l=>l.includes(`"checkpoint":"${point}"`)));}
async function kill(c:ReturnType<typeof child>){c.p.kill('SIGKILL');await c.p.exited;}
function active(e:Env,options:{submitted?:boolean;running?:boolean;partial?:boolean;observed?:boolean;count?:number;at?:string;config?:Record<string,unknown>}={}){
  const agent=e.agents.create({name:'agent-'+e.agents.list().length,provider:'fake',config:options.config??{}});
  const ids=Array.from({length:options.count??1},(_,n)=>send(e,agent.id,'old-'+n)),batch=e.mailbox.claimBatch(agent.id,null)!;
  e.ledger.begin(batch,'fake','fake',options.at);if(options.submitted!==false)e.ledger.submitted(batch.id);
  const sessions=new SqliteSessions(e.store);sessions.put({agentId:agent.id,laneId:null,provider:'fake',nativeThreadId:'old-native-'+agent.id,promptHash:'prefix',configHash:'config'});
  const binding=e.store.db.query<{generation_id:string;native_thread_id:string},[string]>('SELECT * FROM provider_sessions WHERE agent_id=?').get(agent.id)!;
  e.store.write(()=>e.store.db.query('INSERT INTO execution_owners VALUES(?,?,?,?,?)').run(batch.id,'dead-epoch','old-runtime',binding.generation_id,binding.native_thread_id));
  const recorder=new TurnRecorder(e.store,batch,agent,binding.native_thread_id,'prefix',{flushMs:600000});
  if(options.running!==false){e.ledger.started(batch.id,binding.native_thread_id,'native-turn',()=>{recorder.started('native-turn');e.mailbox.markBatchRunning(batch.id,'native-turn');});}
  if(options.partial){recorder.observe({method:'item/agentMessage/delta',params:{threadId:binding.native_thread_id,turnId:'native-turn',itemId:'partial',delta:'durable fragment'}});recorder.flush();}
  if(options.observed){const count=tokenCount(20,0,0,3);e.ledger.observe(batch.id,{last:count,total:count});}
  return{agent,ids,batch,recorder,binding};
}
function fakeRecord(e:Env):RpcProcessRecord{return{version:2,ownerPid:2147483647,childPid:12345,processGroupId:12345,platform:process.platform,recordedAt:new Date().toISOString(),childStartIdentity:'old-start',members:[{pid:12345,identity:'old-start'}],scope:{databaseId:e.store.databaseId,hostId:hostIdentity(),ownerEpoch:'dead-epoch',ownerStartIdentity:'dead-owner',runtimeId:'old-runtime',directory:e.store.processDirectory}};}
function recordFile(e:Env,record:unknown,name='owned.json'){mkdirSync(e.store.processDirectory,{recursive:true});const path=join(e.store.processDirectory,name);writeFileSync(path,typeof record==='string'?record:JSON.stringify(record));return path;}
afterEach(async()=>{
  for(const c of children.splice(0))if(c.exitCode===null){c.kill('SIGKILL');await c.exited;}
  for(const d of daemons.splice(0))await d.stop(0);
  for(const s of stores.splice(0)){
    try{for(const r of readProcessRecords(s.processDirectory))await containProcess(r.record,hostIdentity(),s.databaseId,()=>{},0);}catch{}
    try{s.close();}catch{}
  }
  for(const d of directories.splice(0))rmSync(d,{recursive:true,force:true});
});

test('M7 01: real SIGKILL interrupts old native work and runs its queued successor after containment',async()=>{
  const e=env(),a=e.agents.create({name:'a',provider:'codex'}),old=send(e,a.id),c=child(e);
  await until(()=>e.mailbox.get(old)!.status==='running');const next=send(e,a.id,'successor');await kill(c);
  const d=daemon(e);await d.ready;await until(()=>e.mailbox.get(next)!.status==='completed');
  expect(e.mailbox.get(old)!.status).toBe('interrupted');expect(recoveryReport(e.store).cleanup.every((r:any)=>r.state==='complete')).toBe(true);expect(verifyReplay(e.store).matches).toBe(true);
});
test('M7 02: SIGKILL after claim before setup never restores or retries the starting batch',async()=>{
  const e=env(),a=e.agents.create({name:'a',provider:'codex'}),old=send(e,a.id),c=child(e,'claim');await paused(c,'claim');await kill(c);
  const d=daemon(e);await d.ready;expect(e.mailbox.get(old)!.status).toBe('interrupted');expect(e.store.db.query('SELECT * FROM turns').all()).toEqual([]);expect(e.mailbox.listQueue(a.id)).toEqual([]);
});
test('M7 03: accepted but unacknowledged native start is quarantined without inventing a turn id',async()=>{
  const e=env(),a=e.agents.create({name:'a',provider:'codex'}),old=send(e,a.id),c=child(e,'accepted');await paused(c,'accepted');await kill(c);const d=daemon(e);await d.ready;
  expect(e.mailbox.get(old)!.status).toBe('interrupted');expect(e.store.db.query('SELECT native_turn_id FROM turns').get()).toEqual({native_turn_id:null});expect(recoveryReport(e.store).quarantinedSessions).toHaveLength(1);
});
test('M7 04: provider completed before final dispatch remains interrupted with no fabricated success',async()=>{
  const e=env(),a=e.agents.create({name:'a',provider:'codex'}),old=send(e,a.id),c=child(e,'before-final','echo');await paused(c,'before-final');await kill(c);const d=daemon(e);await d.ready;
  expect(e.mailbox.get(old)!.status).toBe('interrupted');expect(e.ledger.list()).toHaveLength(0);expect(e.ledger.recoveryList()).toHaveLength(1);
});
test('M7 05: SIGKILL after the final commit preserves terminal output and cost without a recovery debit',async()=>{
  const e=env(),a=e.agents.create({name:'a',provider:'codex'}),old=send(e,a.id),c=child(e,'after-final','echo');await paused(c,'after-final');const before=snapshot(e.store.db);await kill(c);const d=daemon(e);await d.ready;
  expect(e.mailbox.get(old)!.status).toBe('completed');expect(snapshot(e.store.db)).toEqual(before);expect(e.ledger.recoveryList()).toHaveLength(0);
});
test('M7 06: halfway recovery failure rolls back the entire batch, partial items, quarantine and gap',async()=>{
  const e=env(),x=active(e,{count:2,partial:true,observed:true}),before=snapshot(e.store.db);
  e.store.write(()=>e.store.db.exec("CREATE TRIGGER fail_recovery BEFORE UPDATE ON deliveries WHEN NEW.seq=2 AND NEW.status='interrupted' BEGIN SELECT RAISE(ABORT,'recovery fault'); END"));
  const d=daemon(e);await expect(d.ready).rejects.toThrow('recovery fault');await d.closed;
  expect(snapshot(e.store.db)).toEqual(before);expect(e.mailbox.activeLanes()).toHaveLength(1);expect(e.store.db.query('SELECT * FROM turn_scratch').all()).toHaveLength(1);
  e.store.write(()=>e.store.db.exec('DROP TRIGGER fail_recovery'));const again=daemon(e);await again.ready;expect(x.ids.every(id=>e.mailbox.get(id)!.status==='interrupted')).toBe(true);
});
test('M7 07: crash after recovery commit resumes cleanup without duplicate interruption evidence',async()=>{
  const e=env(),a=e.agents.create({name:'a',provider:'codex'}),old=send(e,a.id),first=child(e);await until(()=>e.mailbox.get(old)!.status==='running');await kill(first);
  // The SQLite journal must retain ownership even if the external record is lost.
  for(const record of readProcessRecords(e.store.processDirectory))unlinkSync(record.path);
  const second=child(e,'after-recovery-commit');await paused(second,'after-recovery-commit');const before=snapshot(e.store.db);await kill(second);const d=daemon(e);await d.ready;
  expect(snapshot(e.store.db)).toEqual(before);expect(recoveryReport(e.store).executions).toHaveLength(1);
});
test('M7 08: crash after process exit before journal commit observes the gone group on restart',async()=>{
  const e=env(),a=e.agents.create({name:'a',provider:'codex'}),old=send(e,a.id),first=child(e);await until(()=>e.mailbox.get(old)!.status==='running');await kill(first);
  const second=child(e,'after-process-exit');await paused(second,'after-process-exit');expect(e.store.db.query("SELECT state FROM cleanup_journal").get()).toEqual({state:'pending'});await kill(second);
  const d=daemon(e);await d.ready;expect(e.store.db.query('SELECT state FROM cleanup_journal').get()).toEqual({state:'complete'});
});
test('M7 09: recovery receipt and subsequent boots are idempotent for partial text, gaps and charges',async()=>{
  const e=env(),x=active(e,{partial:true,observed:true});
  x.recorder.observe({method:'item/completed',params:{threadId:x.binding.native_thread_id,turnId:'native-turn',item:{id:'complete-tool',type:'tool',details:{name:'Read',content:'kept complete'}}}});x.recorder.flush();
  let d=daemon(e);await d.ready;
  expect(JSON.parse(e.store.db.query<{details_json:string},[]>('SELECT details_json FROM thread_messages WHERE item_id=\'complete-tool\'').get()!.details_json)).toEqual({name:'Read',content:'kept complete'});
  const before=snapshot(e.store.db),events=e.store.db.query('SELECT count(*) AS n FROM events').get();await d.stop(0);
  d=daemon(e);await d.ready;expect(snapshot(e.store.db)).toEqual(before);expect(e.store.db.query('SELECT count(*) AS n FROM events').get()).toEqual(events);
  const lock=(d as any).lock as DaemonLock;recoverExecution(e.store,lock,x.batch.id);expect(snapshot(e.store.db)).toEqual(before);
});
test('M7 10: two daemons cannot recover or schedule the same database',async()=>{
  const e=env(),d=daemon(e);await d.ready;expect(()=>new Daemon(e.store).start()).toThrow('already owns');expect(e.store.db.query('SELECT * FROM boot_runs').all()).toHaveLength(1);
});
test('M7 11: stale heartbeat on a live matching owner does not authorise takeover',async()=>{
  const e=env(),d=daemon(e);await d.ready;e.store.write(()=>e.store.db.exec("UPDATE daemon_lock SET heartbeat_at='2000-01-01'"));expect(()=>new Daemon(e.store).start()).toThrow('already owns');
});
test('M7 12: reused leader PID is untouched; descendants require independent identity evidence',async()=>{
  const e=env(),r=fakeRecord(e),signals:string[]=[];
  const ops:ContainmentOps={identity:pid=>pid===r.childPid?'different':null,members:()=>[{pid:r.childPid,identity:'different'}],signal:(_g,s)=>signals.push(s)};
  await expect(containProcess(r,hostIdentity(),e.store.databaseId,()=>{},0,ops)).rejects.toThrow('Unverified descendants');expect(signals).toEqual([]);
  ops.members=()=>[];expect(await containProcess(r,hostIdentity(),e.store.databaseId,()=>{},0,ops)).toContain('gone');expect(signals).toEqual([]);
});
test('M7 13: real owned runtime and child survive daemon death; verified orphan child is contained',async()=>{
  const e=env(),a=e.agents.create({name:'a',provider:'codex'}),old=send(e,a.id),c=child(e,'descendant');await until(()=>e.mailbox.get(old)!.status==='running');
  await until(()=>readProcessRecords(e.store.processDirectory).some(r=>(r.record.members?.length??0)>=2));const record=readProcessRecords(e.store.processDirectory)[0]!.record;await kill(c);
  // Remove the group leader too: recovery must use the saved child's start identity.
  process.kill(record.childPid,'SIGKILL');await until(()=>!processGroupMembers(record.processGroupId!).some(m=>m.pid===record.childPid));
  const d=daemon(e);await d.ready;expect(processGroupMembers(record.processGroupId!)).toEqual([]);expect(recoveryReport(e.store).barrierOpen).toBe(true);
},10000);
test('M7 14: malformed evidence, permission denial and unverified descendants block every provider start',async()=>{
  for(const kind of ['malformed','malformed-members','permission','orphan']){
    const e=env(),r=fakeRecord(e);recordFile(e,kind==='malformed'?'{truncated':kind==='malformed-members'?{...r,members:[null]}:r);
    const signals:string[]=[],ops:ContainmentOps={identity:pid=>pid===r.childPid?'old-start':null,members:()=>[{pid:r.childPid,identity:kind==='orphan'?'other':'old-start'}],signal:(_g,s)=>{signals.push(s);throw new Error('EPERM: permission denied');}};
    let starts=0;const d=daemon(e,{recovery:{ops,graceMs:0}},()=>{starts++;return new FakeProvider();});await expect(d.ready).rejects.toThrow();await d.closed;
    expect(starts).toBe(0);expect(recoveryReport(e.store).boot!.phase).toBe('blocked');expect(recoveryReport(e.store).barrierOpen).toBe(false);expect(signals.length).toBe(kind==='permission'?1:0);
  }
});
test('M7 15: one shared-runtime cleanup quarantines active generations while retaining idle bindings',async()=>{
  const e=env(),x=active(e),idle=e.agents.create({name:'idle',provider:'fake'}),sessions=new SqliteSessions(e.store);
  sessions.put({agentId:idle.id,laneId:null,provider:'fake',nativeThreadId:'idle-native',configHash:'config',promptHash:'prefix'});recordFile(e,fakeRecord(e));
  const d=daemon(e,{recovery:{ops:{identity:()=>null,members:()=>[],signal:()=>{throw new Error('Must not signal a gone runtime');}}}});await d.ready;
  expect(sessions.get(x.agent.id,null,'fake')).toBeNull();expect(sessions.get(idle.id,null,'fake')!.nativeThreadId).toBe('idle-native');expect(recoveryReport(e.store).cleanup).toHaveLength(1);
});
test('M7 16: CLI enqueue during recovery remains queued until the barrier opens and is never swept',async()=>{
  const e=env(),x=active(e);let resume!:()=>void;const barrier=new Promise<void>(r=>resume=r);let starts=0;
  const d=daemon(e,{recovery:{checkpoint:async name=>{if(name==='before-ready')await barrier;}}},()=>{starts++;return new FakeProvider();});await until(()=>recoveryReport(e.store).boot?.phase==='verify');
  const p=Bun.spawn([process.execPath,new URL('../../src/cli/index.ts',import.meta.url).pathname,'send',x.agent.name,'new CLI work','--db',e.path],{stdout:'pipe',stderr:'pipe'});expect(await p.exited).toBe(0);
  const next=e.mailbox.listQueue(x.agent.id)[0]!;expect(next.status).toBe('queued');expect(starts).toBe(0);resume();await d.ready;await until(()=>e.mailbox.get(next.id)!.status==='completed');expect(e.mailbox.get(x.ids[0]!)!.status).toBe('interrupted');
});
test('M7 17: committed M5 send and its lost-response receipt survive sender recovery exactly once',async()=>{
  const e=env(),x=active(e),b=e.agents.create({name:'recipient',provider:'fake',config:{paused:true}}),router=new ToolRouter(e.mailbox,e.agents,new SqliteToolState(e.store));
  const context={agent:x.agent,batch:x.batch,threadId:x.binding.native_thread_id,turnId:'native-turn'},call:ToolCall={threadId:context.threadId,turnId:context.turnId,callId:'lost',tool:'send_message',arguments:{to:[b.id],text:'committed before crash'}};
  const result=router.handle(context,call),d=daemon(e);await d.ready;expect(e.mailbox.listQueue(b.id)).toHaveLength(1);const before=snapshot(e.store.db);expect(router.handle(context,call)).toEqual(result);expect(snapshot(e.store.db)).toEqual(before);expect(verifyReplay(e.store).matches).toBe(true);
});
test('M7 18: real crash preserves only latest committed partial text and usage snapshots, counted once',async()=>{
  const e=env(),a=e.agents.create({name:'a',provider:'codex'}),old=send(e,a.id),c=child(e,'partial');
  await until(()=>e.store.db.query<{input_total:number},[]>('SELECT input_total FROM usage_records').get()?.input_total===20&&Boolean(e.store.db.query('SELECT 1 FROM turn_scratch').get()));await kill(c);const d=daemon(e);await d.ready;
  const page=new SqliteHistory(e.store).search(a.id,null,'durable partial');expect(page.entries.some(r=>r.text==='latest durable partial answer'&&r.partial&&r.status==='interrupted')).toBe(true);
  const gap=e.ledger.recoveryList()[0]!;expect(JSON.parse(gap.usage_json!).last.totalTokens).toBe(23);expect(e.ledger.list()).toEqual([]);expect(e.store.db.query("SELECT count(*) AS n FROM events WHERE type='item.recovered'").get()).toEqual({n:1});expect(e.mailbox.get(old)!.status).toBe('interrupted');
},10000);
test('M7 19: missing/partial usage holds finite budgets across midnight until an audited bound is recorded',async()=>{
  const e=env(),x=active(e,{observed:true,at:new Date(Date.now()-86400_000).toISOString(),config:{dailyTokens:10000}}),d=daemon(e);await d.ready;const next=send(e,x.agent.id,'next');await until(()=>d.scheduler.status()[0]?.reason==='budget');
  expect(e.ledger.totals(x.agent.id,new BudgetCalendar(),Date.now()).unknownTokens).toBe(true);e.ledger.acknowledge(x.batch.id,30,0,'Reviewed effects; conservative upper bound');await until(()=>e.mailbox.get(next)!.status==='completed');
  expect(e.ledger.recoveryList()[0]!.resolution_json).toContain('conservative');expect(e.store.db.query("SELECT * FROM events WHERE type='recovery.usage_resolved'").all()).toHaveLength(1);expect(e.mailbox.get(x.ids[0]!)!.status).toBe('interrupted');
});
class RawProvider extends FakeProvider {raw(call:ToolCall):Promise<ToolResult>{return this.callTool(call,new AbortController().signal);}}
test('M7 20: an old epoch cannot enqueue tools, finish work or release a new lane after ownership loss',async()=>{
  const e=env(),a=e.agents.create({name:'a',provider:'fake'}),b=e.agents.create({name:'b',provider:'fake',config:{paused:true}}),p=new RawProvider({mode:'stall'});let threadId='',turnId='';
  p.on('notification',n=>{if(n.method==='turn/started'){threadId=n.params.threadId;turnId=n.params.turn.id;}});const old=send(e,a.id),d=daemon(e,{},()=>p);await d.ready;await until(()=>e.mailbox.get(old)!.status==='running');
  const other=new Store(e.path);other.write(()=>other.db.exec("UPDATE daemon_lock SET epoch='replacement-epoch'"));other.close();
  await expect(p.raw({threadId,turnId,callId:'stale',tool:'send_message',arguments:{to:[b.id],text:'forbidden'}})).rejects.toThrow('Stale');
  p.emit('notification',{method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});await d.closed;
  expect(e.mailbox.listQueue(b.id)).toEqual([]);expect(e.mailbox.get(old)!.status).toBe('running');expect(e.mailbox.activeLanes()).toHaveLength(1);expect(e.store.db.query('SELECT * FROM thread_messages').all()).toEqual([]);
});
test('M7 21: setup-only crash retains an unused committed handoff and interrupts its starting delivery',async()=>{
  const e=env(),x=active(e,{observed:true});e.ledger.settle(x.batch.id,'completed',true,()=>{x.recorder.finish({status:'completed'});e.mailbox.finishBatch(x.batch.id,'completed');});
  const sessions=new SqliteSessions(e.store),old=sessions.get(x.agent.id,null,'fake')!;sessions.put({...old,nativeThreadId:'unused-setup-native'});
  const current=send(e,x.agent.id,'setup never submitted'),batch=e.mailbox.claimBatch(x.agent.id,null)!;e.ledger.begin(batch,'fake','fake');
  const binding=sessions.get(x.agent.id,null,'fake')!,thread=new ThreadStore(e.store).get(x.agent.id,null)!;expect(binding.handoffPending).toBe(true);
  const d=daemon(e);await d.ready;expect(e.mailbox.get(current)!.status).toBe('interrupted');expect(sessions.get(x.agent.id,null,'fake')!.handoffPending).toBe(true);expect(new ThreadStore(e.store).get(x.agent.id,null)!.id).toBe(thread.id);expect(recoveryReport(e.store).quarantinedSessions).toEqual([]);
});
test('M7 22: explicit retry preserves agent chain/hop and retry_of while the old attempt stays terminal',async()=>{
  const e=env(),sender=e.agents.create({name:'sender',provider:'fake'}),a=e.agents.create({name:'recipient',provider:'fake'});
  const receipt=e.mailbox.enqueue({sender:{kind:'agent',agentId:sender.id},recipientIds:[a.id],text:'request',chain:{id:'chain',hop:4}}),batch=e.mailbox.claimBatch(a.id,null)!;e.ledger.begin(batch,'fake','fake');e.ledger.submitted(batch.id);
  let forwarded:ToolResult|undefined;
  const d=daemon(e,{maxHops:4},()=>new FakeProvider({script:async(_input,tool)=>{forwarded=await tool('send_message',{to:[sender.id],text:'forward'});return 'finished';}}));await d.ready;const old=e.mailbox.get(receipt.deliveryIds[0]!)!,retry=e.mailbox.retry(old.id);expect(e.mailbox.get(retry.deliveryIds[0]!)!).toMatchObject({retryOf:old.id,chainId:'chain',hop:4});await until(()=>e.mailbox.get(retry.deliveryIds[0]!)!.status==='completed');expect(e.mailbox.get(old.id)!.status).toBe('interrupted');
  expect(forwarded!.success).toBe(false);expect(forwarded!.contentItems[0]!.text).toContain('maxHops');
  expect(e.store.db.query('SELECT * FROM deliveries').all()).toHaveLength(2);
});
test('M7 23: frozen v7 migration/replay is deterministic; orphan reservation and projection drift block boot',async()=>{
  const e=env(),legacy=join(e.dir,'v7.sqlite'),db=new Database(legacy);db.exec(readFileSync(new URL('../fixtures/store/v7.sql',import.meta.url),'utf8'));
  db.exec("CREATE TRIGGER reject_v8 BEFORE INSERT ON schema_migrations WHEN NEW.version=8 BEGIN SELECT RAISE(ABORT,'reject v8'); END");db.close();
  expect(()=>new Store(legacy)).toThrow('reject v8');const rollback=new Database(legacy);expect(rollback.query("SELECT name FROM sqlite_master WHERE name='recoveries'").all()).toEqual([]);rollback.exec('DROP TRIGGER reject_v8');rollback.close();
  const migrated=new Store(legacy);stores.push(migrated);expect(verifyReplay(migrated).matches).toBe(true);expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  const a=e.agents.create({name:'a',provider:'fake'});e.store.write(()=>e.store.db.query("INSERT INTO active_lanes VALUES(?,'','orphan',NULL,'now')").run(a.id));const d=daemon(e);await expect(d.ready).rejects.toThrow('orphan lane');await d.closed;
  e.store.write(()=>e.store.db.exec('DELETE FROM active_lanes'));send(e,a.id);e.store.write(()=>e.store.db.exec("UPDATE messages SET text='drift'"));const broken=daemon(e);await expect(broken.ready).rejects.toThrow('projection drift');await broken.closed;
});
test('M7 24: graceful first signal and forced second signal leave consistent state for the next boot',async()=>{
  const e=env(),a=e.agents.create({name:'a',provider:'codex'}),old=send(e,a.id),c=child(e);await until(()=>e.mailbox.get(old)!.status==='running');
  c.p.kill('SIGTERM');await until(()=>c.lines.some(l=>l.includes('"signal":"SIGTERM"')));c.p.kill('SIGINT');await c.p.exited;
  const status=e.mailbox.get(old)!.status,d=daemon(e);await d.ready;expect(e.mailbox.get(old)!.status).toBe(status==='running'?'interrupted':status);expect(e.mailbox.activeLanes()).toEqual([]);expect(verifyReplay(e.store).matches).toBe(true);
});
