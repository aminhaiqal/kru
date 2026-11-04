import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store,verifyReplay,snapshot} from '../src/store';
import {AgentRegistry,type Agent} from '../src/agents';
import {SqliteMailbox,type Batch} from '../src/mailbox';
import {Daemon,type DaemonOptions} from '../src/daemon';
import {SqliteSessions} from '../src/daemon/sessions';
import {FakeProvider,ClaudeProvider,CodexProvider,type Methods,type ToolCall,type ThreadParams,type ToolResult,type Notification} from '../src/providers';
import {RpcResponseError,RequestTimeoutError} from '../src/rpc';
import {prepareSession,sessionConfigHash} from '../src/scheduler/session';
import {SqliteHistory,ThreadStore} from '../src/threads';
import type {GenerationRow} from '../src/threads/session-types';
import {characters,digestText} from '../src/threads/text';
import {SqliteUsageLedger} from '../src/usage/sqlite';
import {ToolRouter,SqliteToolState} from '../src/tools';
import {nextSequence} from '../src/store/events';
import {demoHandoff} from '../scripts/demo-handoff';
import {scriptedClaude} from './fakes/claude-sdk';
import {sessionScopeHash} from '../src/providers/session-errors';

const directories:string[]=[],stores:Store[]=[],daemons:Daemon[]=[],providers:FakeProvider[]=[];
function env(){const dir=mkdtempSync(join(tmpdir(),'kru-m6-expanded-'));directories.push(dir);const path=join(dir,'db.sqlite'),store=new Store(path);stores.push(store);return{dir,path,store,agents:new AgentRegistry(store),mailbox:new SqliteMailbox(store),sessions:new SqliteSessions(store),history:new SqliteHistory(store)};}
type Env=ReturnType<typeof env>;
async function until(fn:()=>boolean){const end=performance.now()+5000;while(!fn()){if(performance.now()>end)throw new Error('Condition timed out');await Bun.sleep(3);}}
function agent(e:Env,config:Record<string,unknown>={}){return e.agents.create({name:'a-'+e.agents.list().length,provider:'fake',config});}
function enqueue(e:Env,a:Agent,text:string,laneId:string|null=null){return e.mailbox.enqueue({sender:{kind:'user'},recipientIds:[a.id],text,laneId}).deliveryIds[0]!;}
async function send(e:Env,a:Agent,text:string,laneId:string|null=null){const id=enqueue(e,a,text,laneId);try{await until(()=>e.mailbox.get(id)!.status==='completed');}catch(error){throw new Error(`${text}: ${JSON.stringify(e.mailbox.get(id))}; ${JSON.stringify(e.store.db.query('SELECT phase,error FROM boot_runs ORDER BY rowid DESC LIMIT 1').get())}; ${JSON.stringify(e.store.db.query('SELECT state,error FROM session_setup_attempts ORDER BY created_at DESC LIMIT 1').get())}`,{cause:error});}return id;}
async function start(e:Env,factory:ConstructorParameters<typeof Daemon>[2]=()=>new FakeProvider({script:async()=> 'answer'}),options:DaemonOptions={}){const d=new Daemon(e.store,options,factory);daemons.push(d);d.start();await d.ready;return d;}
async function history(e:Env,count=3,answer='retained answer'){const a=agent(e),d=await start(e,()=>new FakeProvider({script:async()=>answer}));for(let n=0;n<count;n++)await send(e,a,'needle fact '+n);await d.stop(0);return a;}
function claim(e:Env,a:Agent,text='current request'):Batch{enqueue(e,a,text);return e.mailbox.claimBatch(a.id,null)!;}
class InspectProvider extends FakeProvider {
  calls:string[]=[];inputs:string[]=[];params:ThreadParams[]=[];discarded:string[]=[];scope=sessionScopeHash('fake');
  gate:Promise<void>|undefined;
  override async sessionScope(){return this.scope;}
  raw(call:ToolCall):Promise<ToolResult>{return this.callTool(call,new AbortController().signal);}
  override async discardSession(id:string){this.discarded.push(id);await super.discardSession(id);}
  override async request<M extends keyof Methods>(method:M,params:Methods[M]['params']):Promise<Methods[M]['result']>{
    this.calls.push(method);if(method==='turn/start')this.inputs.push((params as Methods['turn/start']['params']).input.map(i=>i.text).join('\n'));
    const result=await super.request(method,params);if(method==='thread/start'){this.params.push(structuredClone(params as ThreadParams));if(this.gate)await this.gate;}return result;
  }
}
afterEach(async()=>{for(const d of daemons.splice(0))await d.stop(0);for(const p of providers.splice(0))await p.stop();for(const s of stores.splice(0))s.close();for(const d of directories.splice(0))rmSync(d,{recursive:true,force:true});});

test('M6 expanded 01: ten Claude turns then Codex retrieves a first-turn fact omitted from the packet',async()=>{
  const r=await demoHandoff();expect(r.assertions.firstFactOmittedFromHandoff).toBe(true);expect(r.assertions.retrievedOriginalSource).toBe(true);expect(Object.values(r.assertions).every(Boolean)).toBe(true);
},10000);
test('M6 expanded 02: valid native resume preserves generation and never repeats packet or input',async()=>{
  const e=env(),a=agent(e),p=new InspectProvider();let d=await start(e,()=>p);await send(e,a,'first');const before=e.sessions.get(a.id,null,'fake')!;await d.stop(0);
  d=await start(e,()=>p);await send(e,a,'second');expect(e.sessions.get(a.id,null,'fake')!.generationId).toBe(before.generationId);expect(p.inputs).toEqual(['first','second']);expect(p.calls.filter(c=>c==='thread/resume')).toHaveLength(1);
});
test('M6 expanded 03: missing cache creates a numbered generation with frozen replayable packet',async()=>{
  const e=env(),a=await history(e),before=e.sessions.get(a.id,null,'fake')!,p=new InspectProvider();const d=await start(e,()=>p);await send(e,a,'continue');
  const next=e.sessions.get(a.id,null,'fake')!;expect(next.generation).toBe(before.generation!+1);expect(next.nativeThreadId).not.toBe(before.nativeThreadId);expect(next.logicalThreadId).toBe(before.logicalThreadId);
  expect(p.calls).toContain('thread/resume');expect(e.store.db.query<{reason:string},[string]>('SELECT reason FROM session_generations WHERE id=?').get(next.generationId!)!.reason).toBe('native_session_missing');
  const packet=e.store.db.query<any,[]>('SELECT * FROM handoffs').get()!;expect(packet.packet_hash).toBe(digestText(packet.packet));expect(packet.renderer_version).toBe(1);expect(packet.snapshot_seq).toBeGreaterThan(0);expect(e.store.db.query('SELECT * FROM handoff_uses').all()).toHaveLength(1);expect(d.failure).toBeUndefined();expect(verifyReplay(e.store).matches).toBe(true);
});
test('M6 expanded 04: auth, rate-limit and transient errors hold instead of being classified missing',async()=>{
  for(const message of ['Session credential missing','rate limit 429','Session service unavailable']){
    const e=env(),a=agent(e),p=new InspectProvider();providers.push(p);await p.start();const batch=claim(e,a);await prepareSession(p,a,null,e.sessions,undefined,undefined,{batchId:batch.id});const binding=e.sessions.get(a.id,null,'fake')!;
    const original=p.request.bind(p);p.request=async(m:any,v:any)=>{if(m==='thread/resume')throw new RpcResponseError(-32001,message);return original(m,v);};
    await expect(prepareSession(p,a,null,e.sessions,undefined,undefined,{batchId:batch.id})).rejects.toThrow(message);expect(e.sessions.get(a.id,null,'fake')!.generationId).toBe(binding.generationId);expect(p.calls.filter(c=>c==='thread/start')).toHaveLength(1);
  }
});
test('M6 expanded 05: A to B to A retains retired lineage and never resumes the stale A branch',async()=>{
  const e=env(),a=agent(e);const d=await start(e);await send(e,a,'A fact');e.agents.update(a.id,{provider:'codex'});await send(e,a,'B fact');e.agents.update(a.id,{provider:'fake'});await send(e,a,'back to A');
  const g=e.store.db.query<GenerationRow,[]>('SELECT * FROM session_generations ORDER BY generation').all();expect(g.map(r=>r.generation)).toEqual([1,2,3]);expect(g.map(r=>r.status)).toEqual(['retired','retired','active']);expect(g[2]!.previous_id).toBe(g[1]!.id);expect(d.failure).toBeUndefined();
});
test('M6 expanded 06: config edits during blocked setup and a running turn apply only to the next claim',async()=>{
  const e=env(),a=agent(e,{instructions:'old instructions'}),p=new InspectProvider({mode:'stall'});let release!:()=>void;p.gate=new Promise(r=>release=r);
  const d=await start(e,()=>p);const first=enqueue(e,a,'first');await until(()=>e.store.db.query("SELECT 1 FROM session_setup_attempts WHERE state='creating'").get()!==null);
  e.agents.update(a.id,{config:{instructions:'next instructions'}});release();await until(()=>e.mailbox.get(first)!.status==='running');expect(p.params[0]!.instructions).toContain('old instructions');
  e.agents.update(a.id,{config:{instructions:'latest instructions'}});const next=enqueue(e,a,'next');const old=e.sessions.get(a.id,null,'fake')!;await p.request('turn/interrupt',{threadId:old.nativeThreadId,turnId:e.mailbox.get(first)!.turnId!});await until(()=>e.mailbox.get(next)!.status==='running');expect(p.params.at(-1)!.instructions).toContain('latest instructions');expect(d.failure).toBeUndefined();
  const previous=e.sessions.get(a.id,null,'fake')!;await p.request('turn/interrupt',{threadId:previous.nativeThreadId,turnId:e.mailbox.get(next)!.turnId!});await until(()=>e.mailbox.get(next)!.status==='interrupted');p.scope='different-account-scope';const scoped=enqueue(e,a,'new account');await until(()=>e.mailbox.get(scoped)!.status==='running');expect(e.sessions.get(a.id,null,'fake')!.generation).toBe(previous.generation!+1);expect(e.store.db.query<{reason:string},[]>('SELECT reason FROM session_generations ORDER BY generation DESC LIMIT 1').get()!.reason).toBe('runtime_or_account_scope_changed');
});
test('M6 expanded 07: setup races use lane and generation CAS; obsolete candidates cannot activate',async()=>{
  const e=env(),a=agent(e),p=new InspectProvider();providers.push(p);await p.start();e.sessions.put({agentId:a.id,laneId:null,provider:'fake',nativeThreadId:'old',configHash:'old-config',promptHash:'old'});
  const old=e.store.db.query<GenerationRow,[]>("SELECT * FROM session_generations WHERE status='active'").get()!,batch=claim(e,a);let release!:()=>void;p.gate=new Promise(r=>release=r);
  const pending=prepareSession(p,a,null,e.sessions,undefined,undefined,{batchId:batch.id});await until(()=>e.sessions.pendingSetups(a.id,null).length===1);
  await expect(prepareSession(p,a,null,e.sessions,undefined,undefined,{batchId:batch.id})).rejects.toThrow('unknown');
  e.store.command('competing-activation',()=>{e.store.emit('session.generation_retired',{row:{...old,status:'retired',retired_at:'now',retired_reason:'race'}});e.store.emit('session.generation_activated',{row:{...old,id:'competing-generation',generation:2,previous_id:old.id,status:'active'}});});release();await expect(pending).rejects.toThrow('generation changed');
  expect(p.discarded).toHaveLength(1);expect(e.store.db.query("SELECT id FROM session_generations WHERE status='active'").get()).toEqual({id:'competing-generation'});expect(verifyReplay(e.store).matches).toBe(true);
  const other=env(),a2=agent(other),recipient=agent(other,{paused:true}),views:InspectProvider[]=[];
  const d=await start(other,()=>{const view=new InspectProvider(views.length?{mode:'stall'}:{});views.push(view);return view;});const first=await send(other,a2,'old generation'),priorBinding=other.sessions.get(a2.id,null,'fake')!,oldTurn=other.mailbox.get(first)!.turnId!;
  other.agents.update(a2.id,{config:{instructions:'changed generation'}});const next=enqueue(other,a2,'new active turn');await until(()=>other.mailbox.get(next)!.status==='running');
  await expect(views[0]!.raw({threadId:priorBinding.nativeThreadId,turnId:oldTurn,callId:'late-old-send',tool:'send_message',arguments:{to:[recipient.id],text:'must not enqueue'}})).rejects.toThrow('active');
  views[0]!.emit('notification',{method:'turn/completed',params:{threadId:priorBinding.nativeThreadId,turn:{id:oldTurn,status:'completed'}}});expect(other.mailbox.get(next)!.status).toBe('running');expect(other.mailbox.listQueue(recipient.id)).toEqual([]);expect(d.failure).toBeUndefined();
});
test('M6 expanded 08: create timeout, activation rollback and pre-start crash retain consistent setup evidence',async()=>{
  const e=env(),a=agent(e),p=new InspectProvider();providers.push(p);await p.start();const batch=claim(e,a);const original=p.request.bind(p);
  p.request=async(m:any,v:any)=>{if(m==='thread/start')throw new RequestTimeoutError('thread/start',1);return original(m,v);};
  await expect(prepareSession(p,a,null,e.sessions,undefined,undefined,{batchId:batch.id})).rejects.toThrow('timed out');expect(e.sessions.pendingSetups(a.id,null)[0]!.state).toBe('setup_unknown');expect(p.inputs).toEqual([]);
  await expect(prepareSession(p,a,null,e.sessions,undefined,undefined,{batchId:batch.id})).rejects.toThrow('unknown');await p.stop();await p.start();p.request=original;
  e.store.write(()=>e.store.db.exec("CREATE TRIGGER reject_activation BEFORE INSERT ON provider_sessions BEGIN SELECT RAISE(ABORT,'activation rollback'); END"));
  await expect(prepareSession(p,a,null,e.sessions,undefined,undefined,{batchId:batch.id})).rejects.toThrow('activation rollback');expect(p.discarded).toHaveLength(1);expect(e.store.db.query('SELECT * FROM session_generations').all()).toEqual([]);expect(e.sessions.pendingSetups(a.id,null)).toEqual([]);e.store.write(()=>e.store.db.exec('DROP TRIGGER reject_activation'));
  await prepareSession(p,a,null,e.sessions,undefined,undefined,{batchId:batch.id});const bound=e.sessions.get(a.id,null,'fake')!;expect(bound.generation).toBe(1);expect(p.inputs).toEqual([]);
  await p.stop();const d=await start(e);expect(e.mailbox.get(batch.deliveries[0]!.id)!.status).toBe('interrupted');expect(d.failure).toBeUndefined();
});
test('M6 expanded 09: lost accepted-start response is not resent and the exact generation is quarantined',async()=>{
  const e=env(),a=agent(e);class Unknown extends InspectProvider {
    hide=false;accepted=false;
    override emit(event:any,...args:any[]):boolean{if(this.hide&&event==='notification'&&(args[0] as Notification).method==='turn/started')return false;return super.emit(event,...args as [any]);}
    override async request<M extends keyof Methods>(m:M,v:Methods[M]['params']):Promise<Methods[M]['result']>{if(m==='turn/start'){this.hide=true;await super.request(m,v);this.hide=false;this.accepted=true;throw new RequestTimeoutError(m,1);}return super.request(m,v);}
  }
  const p=new Unknown({mode:'stall'}),d=await start(e,()=>p,{startTimeoutMs:20,startGraceMs:20}),id=enqueue(e,a,'unknown start');await until(()=>e.mailbox.get(id)!.status==='interrupted');
  expect(p.accepted).toBe(true);expect(p.calls.filter(c=>c==='turn/start')).toHaveLength(1);expect(e.store.db.query('SELECT status FROM session_generations').get()).toEqual({status:'quarantined'});expect(e.sessions.get(a.id,null,'fake')).toBeNull();expect(d.failure).toBeUndefined();
});
test('M6 expanded 10: large Unicode packet and current input obey code-point and provider byte ceilings',async()=>{
  const e=env(),a=await history(e,4,'🙂界'.repeat(2000)),seen:string[]=[];const p=new FakeProvider({script:async input=>{seen.push(input);return'done';}});const d=await start(e,()=>p);const current='current-once-'+('界'.repeat(5000));await send(e,a,current);
  const packet=e.store.db.query<any,[]>('SELECT * FROM handoffs').get()!;expect(characters(packet.packet)).toBeLessThanOrEqual(12000);expect(Buffer.byteLength(seen[0]!)).toBeLessThanOrEqual(32768);expect(seen[0]!.split(current)).toHaveLength(2);expect(packet.packet.isWellFormed()).toBe(true);expect(d.failure).toBeUndefined();
  const small=env(),limited=await history(small,3,'🙂'.repeat(2000));let resultBytes=0,inputBytes=0,turns=0;
  class Limited extends FakeProvider {override readonly capabilities={steering:false,subagents:false,compaction:'none',maxInputBytes:2048,maxToolResultBytes:2048} as const;}
  const constrained=await start(small,()=>{const view=new Limited({script:async(input,tool)=>{inputBytes=Buffer.byteLength(input);const result=await tool('history_search',{query:'needle',limit:20});expect(result.success).toBe(true);resultBytes=Buffer.byteLength(JSON.stringify(result));return'handled';}});view.on('notification',n=>{if(n.method==='turn/started')turns++;});return view;});
  await send(small,limited,'bounded lookup');expect(inputBytes).toBeLessThanOrEqual(2048);expect(resultBytes).toBeLessThanOrEqual(2048);const oversized=enqueue(small,limited,'x'.repeat(2049));await until(()=>small.mailbox.get(oversized)!.status==='failed');expect(turns).toBe(1);expect(constrained.failure).toBeUndefined();
});
test('M6 expanded 11: a frozen packet is used once per generation and never enters the stable prefix',async()=>{
  const e=env(),a=await history(e),p=new InspectProvider(),d=await start(e,()=>p);await send(e,a,'new-one');await send(e,a,'new-two');await send(e,a,'new-three');
  expect(p.inputs[0]).toContain('Kru conversation handoff');expect(p.inputs.slice(1)).toEqual(['new-two','new-three']);expect(p.params[0]!.instructions).not.toContain('needle fact');expect(e.store.db.query('SELECT * FROM handoff_uses').all()).toHaveLength(1);expect(d.failure).toBeUndefined();
  const packet=e.store.db.query<any,[]>('SELECT * FROM handoffs').get()!;expect(packet.packet).not.toContain('new-one');expect(()=>e.store.command('attempt-packet-rewrite',()=>e.store.emit('handoff.created',{row:{...packet,packet:packet.packet+'changed'}}))).toThrow('Immutable handoffs');
});
test('M6 expanded 12: exact source IDs and opaque read cursors recover omitted text without indexing search results',async()=>{
  const e=env(),a=await history(e,1,'x'.repeat(2500)+'TAIL-FACT'),source=e.history.search(a.id,null,'needle').matches.find(m=>m.role==='user')!;let page=e.history.query(a.id,null,{messageId:source.relatedEntryId!}),text='';
  for(;;){text+=page.matches[0]!.text;if(!page.nextCursor)break;page=e.history.query(a.id,null,{messageId:source.relatedEntryId!,cursor:page.nextCursor});}expect(text).toEndWith('TAIL-FACT');
  const d=await start(e,()=>new FakeProvider({script:async(_input,tool)=>{await tool('history_search',{query:'needle'});return'looked up';}}));await send(e,a,'lookup');expect(e.history.search(a.id,null,'needle',20).matches.some(m=>m.role==='dynamicToolCall')).toBe(false);expect(d.failure).toBeUndefined();
  const old=e.mailbox.get(e.store.db.query<{id:string},[]>('SELECT id FROM deliveries ORDER BY seq LIMIT 1').get()!.id)!;const retry=e.mailbox.retry(old.id).deliveryIds[0]!;await until(()=>e.mailbox.get(retry)!.status==='completed');expect(e.history.search(a.id,null,'needle',20).matches.filter(m=>m.role==='user')).toHaveLength(1);
});
test('M6 expanded 13: foreign source IDs, side lanes, query mismatches and edited cursor positions disclose nothing',async()=>{
  const e=env(),a=await history(e),b=agent(e),d=await start(e);await send(e,a,'needle side','side');await send(e,b,'needle foreign');
  const first=e.history.search(a.id,null,'needle',1);expect(e.history.query(b.id,null,{messageId:first.matches[0]!.sourceId!}).matches).toEqual([]);expect(e.history.search(a.id,null,'foreign').matches).toEqual([]);expect(()=>e.history.search(a.id,'side','needle',1,first.nextCursor!)).toThrow('cursor');
  const [body,signature]=first.nextCursor!.split('.'),parsed=JSON.parse(Buffer.from(body!,'base64url').toString());parsed.snapshot=0;const changed=Buffer.from(JSON.stringify(parsed)).toString('base64url')+'.'+signature;expect(()=>e.history.search(a.id,null,'needle',1,changed)).toThrow('cursor');expect(d.failure).toBeUndefined();
});
test('M6 expanded 14: pages keep one snapshot while history appends; a database error is a tool error',async()=>{
  const e=env(),a=await history(e),first=e.history.search(a.id,null,'needle',1),turn=e.store.db.query<{id:string},[]>('SELECT id FROM turns ORDER BY started_at LIMIT 1').get()!;
  e.store.command('late-source',()=>e.store.emit('item.completed',{row:{seq:nextSequence(e.store.db,'thread_messages'),turn_id:turn.id,item_id:'late',agent_id:a.id,lane_key:'',type:'agentMessage',text:'needle late-after-snapshot',details_json:null,completed_at:new Date().toISOString()}}));
  const next=e.history.search(a.id,null,'needle',20,first.nextCursor!);expect(next.snapshotSeq).toBe(first.snapshotSeq);expect(next.matches.some(m=>m.text.includes('late-after-snapshot'))).toBe(false);expect(e.history.search(a.id,null,'late-after-snapshot').matches).toHaveLength(1);
  e.store.db.function('kru_fold',{deterministic:true},(_value:unknown)=>{throw new Error('injected lookup error');});let success:boolean|undefined;
  const d=await start(e,()=>new FakeProvider({script:async(_input,tool)=>{success=(await tool('history_search',{query:'needle'})).success;return'handled lookup failure';}}));await send(e,a,'handle failure');expect(success).toBe(false);expect(d.failure).toBeUndefined();
});
test('M6 expanded 15: frozen v8 upgrade, ambiguous cache import and two independent replays preserve evidence',()=>{
  const e=env(),path=join(e.dir,'v8.sqlite'),db=new Database(path);db.exec(readFileSync(new URL('./fixtures/store/v8.sql',import.meta.url),'utf8'));db.exec("INSERT INTO provider_sessions SELECT agent_id,lane_key,'codex','ambiguous-native',prompt_hash,config_hash,updated_at,thread_id,0,handoff_pending,'ambiguous-generation' FROM provider_sessions LIMIT 1");const oldEvents=db.query('SELECT * FROM events ORDER BY seq').all();db.exec("CREATE TRIGGER reject_v9 BEFORE INSERT ON schema_migrations WHEN NEW.version=9 BEGIN SELECT RAISE(ABORT,'reject v9'); END");db.close();
  expect(()=>new Store(path)).toThrow('reject v9');const failed=new Database(path);expect(failed.query("SELECT name FROM sqlite_master WHERE name='handoffs'").all()).toEqual([]);failed.exec('DROP TRIGGER reject_v9');failed.close();const migrated=new Store(path);stores.push(migrated);
  expect(migrated.db.query('SELECT * FROM events ORDER BY seq LIMIT ?').all(oldEvents.length)).toEqual(oldEvents);expect(verifyReplay(migrated).matches).toBe(true);expect(verifyReplay(migrated).matches).toBe(true);expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(new SqliteSessions(migrated).get('fixture-agent',null,'fake')).toBeNull();expect(new SqliteHistory(migrated).search('fixture-agent',null,'missing-query').gaps.length).toBeGreaterThan(0);
});
test('M6 expanded 16: M5 request and reply retain origin lane, chain and receipt across provider replacement',async()=>{
  const e=env(),a=agent(e),b=e.agents.create({name:'reviewer',provider:'fake',config:{paused:true}});let firstCall:ToolCall|undefined,calls=0;
  const d=await start(e,ag=>{const p=new FakeProvider({script:async(_input,tool)=>{if(ag.id===b.id)return'review complete';if(calls++===0){await tool('send_message',{to:[b.id],text:'review request',expectsReply:true});return'request queued';}return'review received';}});p.on('request',r=>{if(r.method==='item/tool/call')firstCall??=r.params;});return p;});
  const root=await send(e,a,'request a review','feature'),request=e.mailbox.listQueue(b.id)[0]!;e.agents.update(a.id,{provider:'codex'});e.agents.update(b.id,{config:{paused:false}});await until(()=>e.store.db.query<{n:number},[]>('SELECT count(*) AS n FROM deliveries WHERE status=\'completed\'').get()!.n===3);
  const reply=e.store.db.query<any,[]>('SELECT d.*,m.reply_to FROM deliveries d JOIN messages m ON m.id=d.message_id ORDER BY d.seq DESC LIMIT 1').get()!;expect(reply.lane_id).toBe('feature');expect(reply.chain_id).toBe(request.chainId);expect(reply.hop).toBe(2);expect(reply.reply_to).toBe(request.messageId);
  const old=e.mailbox.get(root)!,router=new ToolRouter(e.mailbox,e.agents,new SqliteToolState(e.store)),before=snapshot(e.store.db);expect(router.handle({agent:a,batch:{id:old.batchId!,agentId:a.id,laneId:'feature',deliveries:[old]},threadId:firstCall!.threadId,turnId:firstCall!.turnId},firstCall!).success).toBe(true);expect(snapshot(e.store.db)).toEqual(before);expect(d.failure).toBeUndefined();
});
test('M6 expanded 17: setup, packet construction and retrieval add no hidden native turns or ledger rows',async()=>{
  const e=env(),a=agent(e),p=new InspectProvider(),d=await start(e,()=>p);await send(e,a,'one');await send(e,a,'two');
  const starts=p.calls.filter(c=>c==='turn/start').length;expect(starts).toBe(2);expect(new SqliteUsageLedger(e.store).list()).toHaveLength(starts);expect(e.store.db.query('SELECT * FROM turns').all()).toHaveLength(starts);expect(d.failure).toBeUndefined();
});
test('M6 expanded 18: each native adapter classifies failures and handles missing-cache replacement and provider switch',async()=>{
  for(const kind of ['claude','codex'] as const){
    const e=env(),a=e.agents.create({name:'native',provider:kind});const factory=(ag:Agent)=>ag.provider==='claude'?new ClaudeProvider({query:scriptedClaude()}):new CodexProvider({transport:{command:process.execPath,args:[new URL('./fakes/provider-agent.ts',import.meta.url).pathname],processRecordDir:join(e.dir,'native'),stopGraceMs:20}});
    const sample=factory(a);expect(sample.classifySessionFailure(new RpcResponseError(-32001,'Session credential missing'))).toBe('authentication');expect(sample.classifySessionFailure(new RpcResponseError(-32000,'rate limit 429'))).toBe('rate_limit');expect(sample.classifySessionFailure(new RpcResponseError(-32602,'Unknown thread'))).toBe('missing');
    let d=await start(e,factory);await send(e,a,'first native fact');const old=e.sessions.get(a.id,null,kind)!;await d.stop(0);d=await start(e,factory);await send(e,a,'missing cache request');expect(e.sessions.get(a.id,null,kind)!.generation).toBe(old.generation!+1);
    const other=kind==='claude'?'codex':'claude';e.agents.update(a.id,{provider:other});await send(e,a,'switch native provider');expect(e.sessions.get(a.id,null,other)!.logicalThreadId).toBe(old.logicalThreadId);expect(d.failure).toBeUndefined();expect(verifyReplay(e.store).matches).toBe(true);
  }
},15000);
