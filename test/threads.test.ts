import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, verifyReplay, snapshot } from '../src/store';
import { AgentRegistry } from '../src/agents';
import { SqliteMailbox } from '../src/mailbox';
import { Daemon } from '../src/daemon';
import { FakeProvider, type FakeTurnScript } from '../src/providers';
import { SchedulerFake } from './fakes/scheduler-provider';
import { SqliteSessions } from '../src/daemon/sessions';
import { ThreadStore, SqliteHistory, handoffPacket } from '../src/threads';
import type { HistoryEntry } from '../src/threads';
import { TurnRecorder } from '../src/turns/recorder';

let dir: string, path: string, store: Store, agents: AgentRegistry, mailbox: SqliteMailbox;
const daemons: Daemon[] = [];
beforeEach(() => { dir=mkdtempSync(join(tmpdir(),'kru-m6-')); path=join(dir,'db.sqlite'); store=new Store(path); agents=new AgentRegistry(store); mailbox=new SqliteMailbox(store); });
afterEach(async () => { for (const d of daemons.splice(0)) await d.stop(0); store.close(); rmSync(dir,{ recursive:true,force:true }); });
async function until(fn: () => boolean, timeout=3000) { const end=performance.now()+timeout; while (!fn()) { if(performance.now()>end) throw new Error('Timed out'); await Bun.sleep(3); } }
const agent=(name='a') => agents.create({ name,provider:'fake' });
const send=(id:string,text:string,laneId?:string) => mailbox.enqueue({ sender:{kind:'user'},recipientIds:[id],text,...(laneId?{laneId}:{}) }).deliveryIds[0]!;
const done=(id:string) => mailbox.get(id)!.status==='completed';
function start(factory?: ConstructorParameters<typeof Daemon>[2], handoffChars=6000) { const d=new Daemon(store,{handoffChars,providerRetryMs:5},factory); daemons.push(d); d.start(); return d; }
async function history(count=5, script?:FakeTurnScript) {
  const a=agent(); const p=new FakeProvider({script:script??(async input=>`answer for ${input}`)}); const d=start(()=>p);
  for(let n=0;n<count;n++){ const id=send(a.id,`fact-${n}: value-${n}`); await until(()=>done(id)); }
  await d.stop(0); return a;
}

test('missing native cache creates a new session and hands off durable history once',async()=>{
  const a=await history(2), sessions=new SqliteSessions(store), old=sessions.get(a.id,null,'fake')!;
  const p=new SchedulerFake(); const d=start(()=>p);
  const next=send(a.id,'new request'); await until(()=>done(next));
  expect(p.calls.indexOf('thread/resume')).toBeLessThan(p.calls.indexOf('thread/start'));
  expect(p.starts[0]).toContain('Kru conversation handoff'); expect(p.starts[0]).toContain('value-0'); expect(p.starts[0]).toEndWith('new request');
  const fresh=sessions.get(a.id,null,'fake')!; expect(fresh.nativeThreadId).not.toBe(old.nativeThreadId); expect(fresh.logicalThreadId).toBe(old.logicalThreadId); expect(fresh.handoffPending).toBe(false);
  const again=send(a.id,'plain follow-up'); await until(()=>done(again)); expect(p.starts[1]).toBe('plain follow-up'); expect(d.failure).toBeUndefined(); expect(verifyReplay(store).matches).toBe(true);
});

test('successful resume preserves native identity and does not inject duplicate history',async()=>{
  const a=agent(), p=new SchedulerFake(); let d=start(()=>p); const first=send(a.id,'remember'); await until(()=>done(first)); await d.stop(0);
  const old=new SqliteSessions(store).get(a.id,null,'fake')!; d=start(()=>p); const next=send(a.id,'again'); await until(()=>done(next));
  expect(new SqliteSessions(store).get(a.id,null,'fake')!.nativeThreadId).toBe(old.nativeThreadId); expect(p.starts).toEqual(['remember','again']);
});

test('transient resume failure holds work and keeps its binding until resume recovers',async()=>{
  const a=agent(), p=new SchedulerFake(); const d=start(()=>p); const first=send(a.id,'first'); await until(()=>done(first)); await d.stop(0);
  const old=new SqliteSessions(store).get(a.id,null,'fake')!; p.threadReady=false; const replacement=start(()=>p);
  const next=send(a.id,'next'); await until(()=>replacement.scheduler.status()[0]?.reason==='provider-not-ready'&&p.calls.includes('thread/resume'));
  expect(new SqliteSessions(store).get(a.id,null,'fake')!.nativeThreadId).toBe(old.nativeThreadId); expect(mailbox.get(next)!.status).toBe('queued');
  p.threadReady=true; await until(()=>done(next)); expect(p.calls.filter(c=>c==='thread/start')).toHaveLength(1);
});

test('handoff survives setup-only restart until a native turn is confirmed',async()=>{
  const a=await history(1), sessions=new SqliteSessions(store), old=sessions.get(a.id,null,'fake')!;
  sessions.put({...old,nativeThreadId:'new-unused-native'}); expect(sessions.get(a.id,null,'fake')!.handoffPending).toBe(true);
  store.close(); store=new Store(path); agents=new AgentRegistry(store); mailbox=new SqliteMailbox(store);
  const resumed=new SqliteSessions(store).get(a.id,null,'fake')!;
  expect(resumed.handoffPending).toBe(true); expect(new SqliteSessions(store).handoff(resumed,[],6000,32000).text).toContain('value-0');
  expect(()=>new SqliteSessions(store).acknowledgeHandoff(resumed,'unconfirmed')).toThrow('confirmed');
  const d=start(()=>new FakeProvider({script:async()=> 'confirmed'}));const next=send(a.id,'confirm a valid turn');await until(()=>done(next));expect(new SqliteSessions(store).get(a.id,null,'fake')!.handoffPending).toBe(false);expect(d.failure).toBeUndefined();
});

test('handoff is bounded by characters and bytes without splitting Unicode pairs',()=>{
  const entries:HistoryEntry[]=Array.from({length:20},(_,n)=>({id:`item:${n}`,role:'assistant',text:'🙂界'.repeat(1000),timestamp:'now',status:'completed',partial:false,baseSeq:n,phase:1,itemOrder:n}));
  for(const chars of [512,1000,6000]){
    const result=handoffPacket('thread',entries,true,chars,1300);
    expect([...result.text].length).toBeLessThanOrEqual(chars); expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1300); expect(result.truncated).toBe(true); expect(result.text.isWellFormed()).toBe(true);
  }
  expect(handoffPacket('thread',entries,false,512,10).blocked).toBe(true);
});

test('queued and cancelled messages are excluded, and a request with no handoff room fails without losing history',async()=>{
  const a=await history(1); const cancelled=send(a.id,'cancelled-secret'); mailbox.cancel(cancelled);
  const tooLarge=send(a.id,'x'.repeat(32760)); const seen:string[]=[];
  const p=new FakeProvider({script:async input=>{seen.push(input);return'ack';}}); const d=start(()=>p,512);
  await until(()=>mailbox.get(tooLarge)!.status==='failed'); expect(seen).toHaveLength(0); expect(mailbox.get(tooLarge)!.error).toContain('handoff');
  const next=send(a.id,'current-only-once'); const future=send(a.id,'future-secret');
  await until(()=>done(next)&&done(future)); expect(seen[0]).not.toContain('cancelled-secret');
  // Both current inputs may share the user batch, but neither is duplicated in its history section.
  const packet=seen[0]!.split('--- end handoff; current request follows ---')[0]!;
  expect(packet).not.toContain('current-only-once'); expect(packet).not.toContain('future-secret'); expect(packet).toContain('value-0'); expect(d.failure).toBeUndefined();
});

test('search is literal, Unicode-aware and paginated, scoped to one agent lane',async()=>{
  const a=await history(6,async input=>'ÖL % literal '+input), other=agent('other');
  const d=start(()=>new FakeProvider()); const ownSide=send(a.id,'private-side','side'), foreign=send(other.id,'foreign-secret'); await until(()=>done(ownSide)&&done(foreign)); await d.stop(0);
  const source=new SqliteHistory(store); const first=source.search(a.id,null,'öl %',2); expect(first.entries).toHaveLength(2); expect(first.nextCursor).not.toBeNull();
  const next=source.search(a.id,null,'öl %',2,first.nextCursor!); expect(next.entries.some(e=>first.entries.some(f=>f.id===e.id))).toBe(false);
  expect(source.search(a.id,null,'foreign-secret').entries).toEqual([]); expect(source.search(a.id,null,'private-side').entries).toEqual([]);
  expect(()=>source.search(a.id,'side','öl %',2,first.nextCursor!)).toThrow('cursor');
});

test('entry retrieval can read all clipped text and links a matching question to its answer',async()=>{
  const answer='start-'+('inside '.repeat(500))+'-TAIL-SECRET'; const a=await history(1,async()=>answer);
  const source=new SqliteHistory(store), page=source.search(a.id,null,'fact-0'); const user=page.entries.find(e=>e.role==='user')!;
  expect(user.relatedEntryId).toBeDefined(); let offset=0, recovered='';
  while(true){const piece=source.read(a.id,null,user.relatedEntryId!,offset); recovered+=piece.entries[0]!.text; if(piece.nextOffset===null)break; expect(piece.nextOffset!).toBeGreaterThan(offset); offset=piece.nextOffset!;}
  expect(recovered).toBe(answer);
  const other=agent('other'); expect(source.read(other.id,null,user.relatedEntryId!).entries).toEqual([]);
});

test('search response remains bounded even when JSON escaping expands stored content',async()=>{
  const a=await history(6,async()=> 'needle'+ '\u0001'.repeat(2000));
  const result=new SqliteHistory(store).search(a.id,null,'needle',5); expect(JSON.stringify(result).length).toBeLessThanOrEqual(8000); expect(result.entries.length).toBeGreaterThan(0);
});

test('provider-only changes clear incompatible model/full profile while retaining explicit replacements',()=>{
  const a=agents.create({name:'claude',provider:'claude',config:{model:'claude-model',promptProfile:'full',instructions:'Keep this role'}});
  const switched=agents.update(a.id,{provider:'codex'}); expect(switched.config.model).toBeUndefined(); expect(switched.config.promptProfile).toBe('minimal'); expect(switched.config.instructions).toBe('Keep this role');
  expect(agents.update(a.id,{provider:'claude',config:{model:'explicit',promptProfile:'coding'}}).config.model).toBe('explicit');
});

test('v7 migration preserves v5 history, imports thread identities once and rolls back on failure',()=>{
  const legacy=join(dir,'legacy.sqlite'), db=new Database(legacy); db.exec(readFileSync(new URL('./fixtures/store/v5.sql',import.meta.url),'utf8'));
  const oldEvents=db.query('SELECT * FROM events ORDER BY seq').all();
  db.exec("CREATE TRIGGER reject_v7 BEFORE INSERT ON schema_migrations WHEN NEW.version=7 BEGIN SELECT RAISE(ABORT,'reject v7'); END"); db.close();
  expect(()=>new Store(legacy)).toThrow('reject v7'); const inspect=new Database(legacy);
  expect(inspect.query("SELECT name FROM sqlite_master WHERE name='threads'").all()).toEqual([]); expect(inspect.query("SELECT name FROM sqlite_master WHERE name='agent_sessions'").all()).toHaveLength(1);
  inspect.exec('DROP TRIGGER reject_v7'); inspect.close(); const migrated=new Store(legacy), fresh=new Store(':memory:');
  try{
    expect(migrated.db.query('SELECT * FROM events ORDER BY seq LIMIT ?').all(oldEvents.length)).toEqual(oldEvents);
    const binding=new SqliteSessions(migrated).get('fixture-agent',null,'fake')!;
    expect(binding.nativeThreadId).toBe('fixture-native-thread'); expect(binding.handoffPending).toBe(false); expect(binding.logicalThreadId).toBe(new ThreadStore(migrated).get('fixture-agent',null)!.id);
    expect(migrated.db.query('SELECT count(*) AS n FROM turn_threads').get()).toEqual(migrated.db.query('SELECT count(*) AS n FROM turns').get());
    expect(verifyReplay(migrated).matches).toBe(true); expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    const schema=(s:Store)=>s.db.query("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(); expect(schema(migrated)).toEqual(schema(fresh));
    const count=migrated.db.query('SELECT count(*) AS n FROM events').get(); const reopen=new Store(legacy); try{expect(reopen.db.query('SELECT count(*) AS n FROM events').get()).toEqual(count);}finally{reopen.close();}
  }finally{migrated.close();fresh.close();}
});

test('interrupted partial answers remain labelled, and history order survives a backwards clock',()=>{
  const a=agent(); let now=Date.parse('2026-11-05T12:00:00Z'); mailbox=new SqliteMailbox(store,{now:()=>now});
  for(const text of ['first','second']){
    send(a.id,text); const batch=mailbox.claimBatch(a.id,null)!, native=batch.id;
    const record=new TurnRecorder(store,batch,a,native,'prefix',{now:()=>now}); record.started(native); mailbox.markBatchRunning(batch.id,native);
    record.observe({method:'item/agentMessage/delta',params:{threadId:native,turnId:native,itemId:'answer',delta:`partial ${text}`}});
    store.atomic(()=>{record.finish({status:'interrupted'}); mailbox.finishBatch(batch.id,'interrupted');});
    now-=86400_000;
  }
  const source=new SqliteHistory(store), thread=new ThreadStore(store).get(a.id,null)!;
  const entries=source.handoffEntries(thread.id,[]).entries;
  expect(entries.filter(e=>e.role!=='execution').map(e=>e.text)).toEqual(['first','partial first','second','partial second']);
  expect(entries.filter(e=>e.role==='assistant').every(e=>e.partial&&e.status==='interrupted')).toBe(true);
  expect(source.search(a.id,null,'partial',1).entries[0]!.text).toBe('partial second'); expect(verifyReplay(store).matches).toBe(true);
});

test('provider sessions are operational; replay retains logical threads and turn links only',async()=>{
  const a=await history(2); const before=snapshot(store.db); new SqliteSessions(store).remove(a.id,null,'fake');
  expect(snapshot(store.db)).toEqual(before); expect(new ThreadStore(store).get(a.id,null)).not.toBeNull(); expect(verifyReplay(store).matches).toBe(true);
});
